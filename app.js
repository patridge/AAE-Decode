const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const browseBtn = document.getElementById("browseBtn");
const errorMessage = document.getElementById("errorMessage");
const fileNameEl = document.getElementById("fileName");
const rawSection = document.getElementById("rawSection");
const rawXmlEl = document.getElementById("rawXml");
const decodedSection = document.getElementById("decodedSection");
const decodedJsonEl = document.getElementById("decodedJson");

browseBtn.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
        handleFile(fileInput.files[0]);
    }
});

function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.classList.add("visible");
}

function clearError() {
    errorMessage.textContent = "";
    errorMessage.classList.remove("visible");
}

function handleFile(file) {
    clearError();
    rawSection.classList.remove("visible");
    decodedSection.classList.remove("visible");
    fileNameEl.textContent = "";

    const reader = new FileReader();
    reader.onload = async (e) => {
        const xmlText = e.target.result;

        fileNameEl.textContent = file.name;
        rawXmlEl.textContent = xmlText;
        rawSection.classList.add("visible");

        try {
            const decoded = await decodeAdjustmentData(xmlText);
            decodedJsonEl.textContent = decoded;
            decodedSection.classList.add("visible");
        } catch (err) {
            showError("Failed to decode adjustment data: " + err.message);
        }
    };
    reader.onerror = () => showError("Failed to read file.");
    reader.readAsText(file);
}

async function decodeAdjustmentData(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");

    const parseError = doc.querySelector("parsererror");
    if (parseError) {
        throw new Error("Invalid XML: " + parseError.textContent);
    }

    const dict = doc.querySelector("plist > dict");
    if (!dict) {
        throw new Error("No <dict> element found in plist.");
    }

    // Find the <data> element that follows the adjustmentData <key>
    let dataElement = null;
    const children = dict.children;
    for (let i = 0; i < children.length; i++) {
        if (children[i].tagName === "key" && children[i].textContent.trim() === "adjustmentData") {
            const next = children[i + 1];
            if (next && next.tagName === "data") {
                dataElement = next;
            }
            break;
        }
    }

    if (!dataElement) {
        throw new Error("No adjustmentData <data> element found.");
    }

    // Base64 decode
    const base64String = dataElement.textContent.replace(/\s+/g, "");
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // Detect format: binary plist starts with "bplist00"
    const magic = new TextDecoder("ascii").decode(bytes.slice(0, 8));
    if (magic === "bplist00") {
        return decodeBinaryPlist(bytes);
    }

    // Otherwise, try raw deflate decompression
    return await decodeDeflateJson(bytes);
}

async function decodeDeflateJson(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();

    const decompressedReader = ds.readable.getReader();
    const chunks = [];
    while (true) {
        const { done, value } = await decompressedReader.read();
        if (done) break;
        chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const decompressed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        decompressed.set(chunk, offset);
        offset += chunk.length;
    }

    const jsonString = new TextDecoder("utf-8").decode(decompressed);

    try {
        return JSON.stringify(JSON.parse(jsonString), null, 2);
    } catch {
        return jsonString;
    }
}

// --- Binary plist parser ---

function decodeBinaryPlist(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.length;

    // Trailer: last 32 bytes
    //   [6]    offsetIntSize
    //   [7]    objectRefSize
    //   [8-15] numObjects (uint64)
    //   [16-23] topObject (uint64)
    //   [24-31] offsetTableOffset (uint64)
    const trailerOffset = len - 32;
    const offsetIntSize = bytes[trailerOffset + 6];
    const objectRefSize = bytes[trailerOffset + 7];
    const numObjects = readUint64(view, trailerOffset + 8);
    const topObject = readUint64(view, trailerOffset + 16);
    const offsetTableOffset = readUint64(view, trailerOffset + 24);

    // Read offset table
    const offsets = [];
    for (let i = 0; i < numObjects; i++) {
        offsets.push(readSizedInt(view, offsetTableOffset + i * offsetIntSize, offsetIntSize));
    }

    // Parse objects
    const objects = [];
    for (let i = 0; i < numObjects; i++) {
        objects.push(parseObject(bytes, view, offsets[i], objectRefSize));
    }

    // Resolve references
    const resolved = resolveObject(objects, topObject);

    // If it's an NSKeyedArchiver, unarchive it
    if (resolved && resolved.$archiver === "NSKeyedArchiver" && resolved.$objects) {
        const unarchived = unarchiveNSKeyedArchiver(resolved);
        return JSON.stringify(unarchived, null, 2);
    }

    return JSON.stringify(resolved, null, 2);
}

function readUint64(view, offset) {
    // Read as two 32-bit values; fine for sizes < 2^53
    const hi = view.getUint32(offset);
    const lo = view.getUint32(offset + 4);
    return hi * 0x100000000 + lo;
}

function readSizedInt(view, offset, size) {
    if (size === 1) return view.getUint8(offset);
    if (size === 2) return view.getUint16(offset);
    if (size === 4) return view.getUint32(offset);
    if (size === 8) return readUint64(view, offset);
    throw new Error("Unsupported int size: " + size);
}

function parseObject(bytes, view, offset, objectRefSize) {
    const marker = bytes[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;

    switch (type) {
        case 0x0: // null, bool, fill
            if (info === 0x00) return null;       // null
            if (info === 0x08) return false;       // bool false
            if (info === 0x09) return true;        // bool true
            return null;

        case 0x1: { // int
            const byteCount = 1 << info;
            if (byteCount === 1) return view.getUint8(offset + 1);
            if (byteCount === 2) return view.getUint16(offset + 1);
            if (byteCount === 4) return view.getUint32(offset + 1);
            if (byteCount === 8) return readUint64(view, offset + 1);
            return 0;
        }

        case 0x2: { // real
            const byteCount = 1 << info;
            if (byteCount === 4) return view.getFloat32(offset + 1);
            if (byteCount === 8) return view.getFloat64(offset + 1);
            return 0;
        }

        case 0x3: { // date (Core Foundation absolute time: seconds since 2001-01-01)
            const timestamp = view.getFloat64(offset + 1);
            const cfEpoch = Date.UTC(2001, 0, 1) / 1000;
            return new Date((cfEpoch + timestamp) * 1000).toISOString();
        }

        case 0x4: { // data (raw bytes)
            let count = info;
            let dataOffset = offset + 1;
            if (info === 0x0f) {
                const { value, newOffset } = readExtendedCount(bytes, view, offset + 1);
                count = value;
                dataOffset = newOffset;
            }
            return { __bplist_data: Array.from(bytes.slice(dataOffset, dataOffset + count)) };
        }

        case 0x5: { // ASCII string
            let count = info;
            let strOffset = offset + 1;
            if (info === 0x0f) {
                const { value, newOffset } = readExtendedCount(bytes, view, offset + 1);
                count = value;
                strOffset = newOffset;
            }
            return new TextDecoder("ascii").decode(bytes.slice(strOffset, strOffset + count));
        }

        case 0x6: { // UTF-16 string
            let count = info;
            let strOffset = offset + 1;
            if (info === 0x0f) {
                const { value, newOffset } = readExtendedCount(bytes, view, offset + 1);
                count = value;
                strOffset = newOffset;
            }
            const utf16 = new Uint16Array(count);
            for (let i = 0; i < count; i++) {
                utf16[i] = view.getUint16(strOffset + i * 2);
            }
            return String.fromCharCode(...utf16);
        }

        case 0x8: { // UID
            const uidLen = info + 1;
            return { "CF$UID": readSizedInt(view, offset + 1, uidLen) };
        }

        case 0xa: { // array
            let count = info;
            let arrOffset = offset + 1;
            if (info === 0x0f) {
                const { value, newOffset } = readExtendedCount(bytes, view, offset + 1);
                count = value;
                arrOffset = newOffset;
            }
            const refs = [];
            for (let i = 0; i < count; i++) {
                refs.push(readSizedInt(view, arrOffset + i * objectRefSize, objectRefSize));
            }
            return { __bplist_array: refs };
        }

        case 0xd: { // dict
            let count = info;
            let dictOffset = offset + 1;
            if (info === 0x0f) {
                const { value, newOffset } = readExtendedCount(bytes, view, offset + 1);
                count = value;
                dictOffset = newOffset;
            }
            const keyRefs = [];
            const valRefs = [];
            for (let i = 0; i < count; i++) {
                keyRefs.push(readSizedInt(view, dictOffset + i * objectRefSize, objectRefSize));
            }
            const valStart = dictOffset + count * objectRefSize;
            for (let i = 0; i < count; i++) {
                valRefs.push(readSizedInt(view, valStart + i * objectRefSize, objectRefSize));
            }
            return { __bplist_dict: { keyRefs, valRefs } };
        }

        default:
            return null;
    }
}

function readExtendedCount(bytes, view, offset) {
    const marker = bytes[offset];
    const intType = marker & 0x0f;
    const byteCount = 1 << intType;
    return {
        value: readSizedInt(view, offset + 1, byteCount),
        newOffset: offset + 1 + byteCount,
    };
}

function resolveObject(objects, index) {
    const obj = objects[index];
    if (obj === null || typeof obj !== "object") return obj;
    if (typeof obj === "string") return obj;

    if (obj.__bplist_array) {
        return obj.__bplist_array.map((ref) => resolveObject(objects, ref));
    }

    if (obj.__bplist_dict) {
        const result = {};
        const { keyRefs, valRefs } = obj.__bplist_dict;
        for (let i = 0; i < keyRefs.length; i++) {
            const key = resolveObject(objects, keyRefs[i]);
            result[key] = resolveObject(objects, valRefs[i]);
        }
        return result;
    }

    if (obj.__bplist_data) {
        return obj;
    }

    if (obj["CF$UID"] !== undefined) {
        return obj;
    }

    return obj;
}

function unarchiveNSKeyedArchiver(root) {
    const objects = root.$objects;
    const topUid = root.$top?.root?.["CF$UID"];
    if (topUid === undefined) return root;

    function resolve(obj) {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj !== "object") return obj;

        if (obj["CF$UID"] !== undefined) {
            return resolve(objects[obj["CF$UID"]]);
        }

        if (Array.isArray(obj)) {
            return obj.map(resolve);
        }

        // Check for NS-style dictionary
        if (obj["NS.keys"] && obj["NS.objects"]) {
            const keys = obj["NS.keys"].map(resolve);
            const vals = obj["NS.objects"].map(resolve);
            const result = {};
            for (let i = 0; i < keys.length; i++) {
                result[keys[i]] = vals[i];
            }
            return result;
        }

        // Check for NS-style array
        if (obj["NS.objects"] && !obj["NS.keys"]) {
            return obj["NS.objects"].map(resolve);
        }

        // Generic object — resolve all values
        const result = {};
        for (const [key, val] of Object.entries(obj)) {
            if (key === "$class" || key === "$classes" || key === "$classname") continue;
            result[key] = resolve(val);
        }
        return result;
    }

    return resolve(objects[topUid]);
}

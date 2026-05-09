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

    // Decompress using the browser's DecompressionStream API (raw deflate, no zlib header)
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

    // Decode to string
    const jsonString = new TextDecoder("utf-8").decode(decompressed);

    // Pretty-print if valid JSON
    try {
        return JSON.stringify(JSON.parse(jsonString), null, 2);
    } catch {
        return jsonString;
    }
}

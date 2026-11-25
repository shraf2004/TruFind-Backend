const { randomUUID } = require("node:crypto");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const IMAGE_TYPES = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"]
]);

async function isSupportedImage(file) {
    if (!IMAGE_TYPES.has(file.mimetype)) return false;
    const { fileTypeFromBuffer } = await import("file-type");
    try {
        const detected = await fileTypeFromBuffer(file.buffer);
        if (detected?.mime !== file.mimetype) return false;
        if (file.mimetype === "image/jpeg") {
            return file.buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2;
        }
        if (file.mimetype === "image/webp") {
            return file.buffer.length >= 20 && file.buffer.readUInt32LE(4) + 8 <= file.buffer.length;
        }
        return true;
    } catch (error) {
        if (error.name === "EndOfStreamError") return false;
        throw error;
    }
}

function createImageStorage({ bucket, client, signUrl }) {
    if (!bucket) throw new Error("S3_BUCKET is required");
    const base = `s3://${bucket}/`;

    function objectKey(reference) {
        if (typeof reference !== "string" || !reference.startsWith(base)) return null;
        const key = reference.slice(base.length);
        return key === key.trim() && /^posts\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(key) ? key : null;
    }

    return {
        async upload(file) {
            const key = `posts/${randomUUID()}.${IMAGE_TYPES.get(file.mimetype)}`;
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: file.buffer,
                ContentType: file.mimetype
            }));
            return base + key;
        },

        async readUrl(reference) {
            if (typeof reference !== "string" || !/^s3:/i.test(reference)) return reference;
            const key = objectKey(reference);
            if (!key) return "No image";
            const url = await signUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
            if (new URL(url).protocol !== "https:") throw new Error("S3 image URL must use HTTPS");
            return url;
        },

        async remove(reference) {
            const key = objectKey(reference);
            if (key) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        }
    };
}

module.exports = { createImageStorage, isSupportedImage };

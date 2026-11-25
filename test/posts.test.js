const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { after, before, test, mock } = require("node:test");
const bcrypt = require("bcrypt");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const createApp = require("../app");
const { createImageStorage } = require("../image-storage");

const passwordHash = bcrypt.hashSync("test password", 4);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP7//2Q==", "base64");
const webp = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=", "base64");
const bucket = "test-bucket";
const posts = new Map();
const objects = new Map();
let nextId = 1;
let failedQuery;
let failedCommand;
let failSigning = false;
const query = mock.fn((sql, params, callback) => {
    if (failedQuery && sql.startsWith(failedQuery)) return callback(new Error("Test database failure"));
    if (sql.startsWith("SELECT * FROM users WHERE email")) {
        assert.match(sql, /is_verified = true/);
        const id = { "one@truman.edu": 1, "two@truman.edu": 2 }[params[0]];
        return callback(null, { rows: id ? [{ id, name: "Test user", password: passwordHash }] : [] });
    }
    if (sql.startsWith("INSERT INTO posts")) {
        posts.set(nextId++, { owner: String(params[0]), image: params[3] });
        return callback(null, { rowCount: 1 });
    }
    if (sql.startsWith("DELETE FROM posts")) {
        assert.equal(sql, "DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING image_url");
        const id = Number(params[0]);
        const post = posts.get(id);
        const owned = post?.owner === String(params[1]);
        if (owned) posts.delete(id);
        return callback(null, { rowCount: Number(owned), rows: owned ? [{ image_url: post.image }] : [] });
    }
    if (sql.includes("FROM posts")) {
        const rows = [...posts.entries()]
            .filter(([, post]) => !params.length || post.owner === params[0])
            .map(([id, post]) => ({ id, user_id: post.owner, image_url: post.image }));
        return callback(null, { rows });
    }
    assert.fail("Unexpected database query");
});
const send = mock.fn(async command => {
    const { Bucket, Key, Body } = command.input;
    assert.equal(Bucket, bucket);
    assert.match(Key, /^posts\//);
    if (command.constructor === failedCommand) throw new Error("Test S3 failure");
    if (command instanceof PutObjectCommand) objects.set(Key, Body);
    else if (command instanceof DeleteObjectCommand) {
        assert.ok(![...posts.values()].some(post => post.image === `s3://${Bucket}/${Key}`));
        objects.delete(Key);
    }
    else assert.fail("Unexpected S3 command");
});
const client = { send };
let signatures = 0;
const signUrl = mock.fn(async (signingClient, command, options) => {
    assert.equal(signingClient, client);
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Bucket, bucket);
    assert.equal(options.expiresIn, 900);
    if (failSigning) throw new Error("Test signing failure");
    return `https://example.test/${command.input.Key}?signature=${++signatures}`;
});
let server;
let baseUrl;
let firstUser;
let secondUser;
let issueToken;

async function request(path, options, token) {
    const headers = { ...options.headers };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(baseUrl + path, { ...options, headers });
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("cache-control") };
}

function login(email, password = "test password") {
    return request("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
    });
}

function createPost(token, fields = {}) {
    const body = new FormData();
    body.append("title", "Post");
    body.append("description", "A test post");
    if (fields.image !== null) {
        body.append(fields.fileField ?? "image",
            new Blob([fields.image ?? png], { type: fields.type ?? "image/png" }), "caller-file.png");
    }
    if (fields.owner) {
        body.append("user_id", fields.owner);
        body.append("userId", fields.owner);
    }
    return request("/posts", { method: "POST", body }, token);
}

before(async () => {
    const dependencies = {
        pool: {
            query(sql, params, callback) {
                if (callback) return query(sql, params, callback);
                return new Promise((resolve, reject) => {
                    query(sql, params, (error, result) => error ? reject(error) : resolve(result));
                });
            }
        },
        nodemailer: { createTransport: () => assert.fail("Unexpected email") },
        images: createImageStorage({ bucket, client, signUrl })
    };
    delete process.env.AUTH_TOKEN_SECRET;
    assert.throws(() => createApp(dependencies), /AUTH_TOKEN_SECRET is required/);
    process.env.AUTH_TOKEN_SECRET = randomBytes(32).toString("hex");
    const app = createApp(dependencies);
    ({ issueToken } = require("../auth"));

    await new Promise((resolve, reject) => {
        server = app.listen(0, "127.0.0.1", resolve);
        server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    firstUser = (await login("one@truman.edu")).body;
    secondUser = (await login("two@truman.edu")).body;
});

after(() => {
    if (server) return new Promise(resolve => server.close(resolve));
});

test("verified login issues a token valid for one hour", async () => {
    const start = Date.now();
    const { body } = await login("one@truman.edu");
    assert.equal(body.success, true);
    assert.equal(body.id, 1);
    assert.ok(body.token);
    assert.ok(body.expiresAt >= start + 3600000);
    assert.ok(body.expiresAt <= Date.now() + 3600000);
    assert.equal((await login("one@truman.edu", "wrong")).body.token, undefined);
    assert.equal((await login("unverified@truman.edu")).body.token, undefined);
});

test("health remains public", async () => {
    assert.deepEqual(await request("/health", {}), {
        status: 200,
        body: { status: "ok", service: "trufind-backend" },
        cacheControl: null
    });
});

test("unauthenticated writes stop before image parsing or database queries", async () => {
    const date = mock.method(Date, "now", () => new Date("2020-01-01").getTime());
    const expired = issueToken(1).token;
    date.mock.restore();
    const tampered = firstUser.token.replace(/^1\./, "2.");
    const extended = expired.replace(/\.\d{13}\./, `.${Date.now() + 3600000}.`);
    const beforeQueries = query.mock.callCount();
    const beforeUploads = send.mock.callCount();

    for (const token of [undefined, "invalid", tampered, expired, extended]) {
        assert.equal((await createPost(token)).status, 401);
        assert.equal((await createPost(token, { fileField: "unexpected" })).status, 401);
        assert.equal((await request("/delete-posts/1?userId=1", { method: "DELETE" }, token)).status, 401);
    }
    assert.equal(query.mock.callCount(), beforeQueries);
    assert.equal(send.mock.callCount(), beforeUploads);
});

test("users can create and delete their own posts and supplied IDs are ignored", async () => {
    const id = nextId;
    assert.equal((await createPost(firstUser.token, { owner: "2" })).body.success, true);
    const { owner, image } = posts.get(id);
    assert.equal(owner, "1");
    assert.match(image, /^s3:\/\/test-bucket\/posts\/[\da-f-]{36}\.png$/);
    const key = image.slice(`s3://${bucket}/`.length);
    assert.deepEqual(objects.get(key), png);
    assert.equal(send.mock.calls.at(-1).arguments[0].input.ContentType, "image/png");

    const path = `/delete-posts/${id}`;
    const denied = await request(`${path}?userId=1`, { method: "DELETE" }, secondUser.token);
    assert.equal(denied.status, 404);
    assert.equal(posts.get(id).owner, "1");
    assert.ok(objects.has(key));

    const deleted = await request(`${path}?userId=2`, { method: "DELETE" }, firstUser.token);
    assert.equal(deleted.body.success, true);
    assert.equal(posts.has(id), false);
    assert.equal(objects.has(key), false);
});

test("validates image type and contents and enforces the 5 MiB limit", async () => {
    const beforeQueries = query.mock.callCount();
    const beforeCommands = send.mock.callCount();
    const invalid = [
        { image: png, type: "image/gif" },
        { image: webp, type: "image/png" },
        { image: Buffer.from("not an image"), type: "image/jpeg" },
        { image: jpeg.subarray(0, 40), type: "image/jpeg" },
        { image: webp.subarray(0, 24), type: "image/webp" },
        { image: png.subarray(0, 8) }
    ];
    for (const fields of invalid) {
        const result = await createPost(firstUser.token, fields);
        assert.equal(result.status, 400);
        assert.match(result.body.message, /JPEG, PNG, or WebP/);
    }
    const maxSize = 5 * 1024 * 1024;
    const oversized = await createPost(firstUser.token, { image: Buffer.alloc(maxSize + 1) });
    assert.equal(oversized.status, 413);
    assert.match(oversized.body.message, /5 MiB/);
    assert.equal((await createPost(firstUser.token, { image: Buffer.alloc(maxSize + 2) })).status, 413);
    assert.equal(query.mock.callCount(), beforeQueries);
    assert.equal(send.mock.callCount(), beforeCommands);

    const boundary = Buffer.alloc(maxSize);
    png.copy(boundary);
    assert.equal((await createPost(firstUser.token, { image: boundary })).body.success, true);
    assert.equal((await createPost(firstUser.token, { image: jpeg, type: "image/jpeg" })).body.success, true);
    assert.match(send.mock.calls.at(-1).arguments[0].input.Key, /\.jpg$/);
});

test("both feeds sign only allowed S3 references and preserve existing images", async () => {
    posts.clear();
    const first = nextId;
    for (let i = 0; i < 2; i++) {
        assert.equal((await createPost(firstUser.token, { image: webp, type: "image/webp" })).body.success, true);
        assert.equal(send.mock.calls.at(-1).arguments[0].input.ContentType, "image/webp");
    }
    const durable = posts.get(first).image;
    assert.notEqual(durable, posts.get(first + 1).image);
    const cloudinary = "https://res.cloudinary.com/example/image/upload/old.png";
    posts.set(nextId++, { owner: "1", image: cloudinary });
    assert.equal((await createPost(firstUser.token, { image: null })).body.success, true);
    for (const image of ["s3://other-bucket/posts/photo.png", `s3://${bucket}/outside/photo.png`,
        `s3://${bucket}/posts/../photo.png`]) {
        posts.set(nextId++, { owner: "1", image });
    }

    const beforeSignatures = signUrl.mock.callCount();
    const all = await request("/all-posts", {});
    const own = await request("/posts/1", {});
    for (const result of [all, own]) {
        assert.equal(result.status, 200);
        assert.equal(result.cacheControl, "no-store");
        const urls = result.body.posts.map(post => post.image_url);
        assert.match(urls[0], /^https:\/\/example.test\/posts\/.*\.webp\?signature=/);
        assert.match(urls[1], /^https:\/\/example.test\/posts\/.*\.webp\?signature=/);
        assert.deepEqual(urls.slice(2), [cloudinary, "No image", "No image", "No image", "No image"]);
    }
    assert.notEqual(all.body.posts[0].image_url, own.body.posts[0].image_url);
    assert.equal(signUrl.mock.callCount() - beforeSignatures, 4);
    assert.equal(posts.get(first).image, durable);

    failSigning = true;
    try {
        const result = await request("/all-posts", {});
        assert.equal(result.status, 500);
        assert.equal(result.body.success, false);
    } finally {
        failSigning = false;
    }
});

test("storage and database failures leave the expected post and object state", async t => {
    const log = t.mock.method(console, "error", () => {});
    const beforeQueries = query.mock.callCount();
    failedCommand = PutObjectCommand;
    assert.equal((await createPost(firstUser.token)).status, 500);
    assert.equal(query.mock.callCount(), beforeQueries);
    failedCommand = undefined;

    failedQuery = "INSERT INTO posts";
    const objectCount = objects.size;
    assert.equal((await createPost(firstUser.token)).status, 500);
    const [put, remove] = send.mock.calls.slice(-2).map(call => call.arguments[0]);
    assert.ok(put instanceof PutObjectCommand);
    assert.ok(remove instanceof DeleteObjectCommand);
    assert.equal(put.input.Key, remove.input.Key);
    assert.equal(objects.size, objectCount);

    failedCommand = DeleteObjectCommand;
    assert.equal((await createPost(firstUser.token)).status, 500);
    assert.equal(log.mock.calls.at(-1).arguments[1].reason, "post insert failed");
    failedCommand = undefined;
    failedQuery = undefined;

    const id = nextId;
    assert.equal((await createPost(firstUser.token)).body.success, true);
    const path = `/delete-posts/${id}`;
    const beforeDelete = send.mock.callCount();
    failedQuery = "DELETE FROM posts";
    assert.equal((await request(path, { method: "DELETE" }, firstUser.token)).status, 500);
    assert.equal(send.mock.callCount(), beforeDelete);
    assert.ok(posts.has(id));
    failedQuery = undefined;

    failedCommand = DeleteObjectCommand;
    const durable = posts.get(id).image;
    const result = await request(path, { method: "DELETE" }, firstUser.token);
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(posts.has(id), false);
    assert.deepEqual(log.mock.calls.at(-1).arguments, [
        "S3 image cleanup failed", { reason: "post deleted", reference: durable }
    ]);
    failedCommand = undefined;

    const beforeLegacy = send.mock.callCount();
    for (const image of ["https://res.cloudinary.com/example/old.png", "No image",
        `s3://${bucket}/private/old.png`, "s3://other-bucket/posts/old.png"]) {
        const legacyId = nextId++;
        posts.set(legacyId, { owner: "1", image });
        assert.equal((await request(`/delete-posts/${legacyId}`, { method: "DELETE" }, firstUser.token)).status, 200);
    }
    assert.equal(send.mock.callCount(), beforeLegacy);
});

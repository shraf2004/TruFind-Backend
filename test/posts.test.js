const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { after, before, test, mock } = require("node:test");
const bcrypt = require("bcrypt");

const createApp = require("../app");

const passwordHash = bcrypt.hashSync("test password", 4);
const posts = new Map();
let nextId = 1;
const query = mock.fn((sql, params, callback) => {
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
        assert.equal(sql, "DELETE FROM posts WHERE id = $1 AND user_id = $2");
        const id = Number(params[0]);
        const owned = posts.get(id)?.owner === String(params[1]);
        if (owned) posts.delete(id);
        return callback(null, { rowCount: Number(owned) });
    }
    assert.fail("Unexpected database query");
});
const upload = mock.fn((_options, callback) => ({
    end(buffer) {
        assert.equal(buffer.toString(), "image bytes");
        callback(null, { secure_url: "https://example.test/image.png" });
    }
}));
let server;
let baseUrl;
let firstUser;
let secondUser;
let issueToken;

async function request(path, options, token) {
    const headers = { ...options.headers };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(baseUrl + path, { ...options, headers });
    return { status: response.status, body: await response.json() };
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
    body.append(fields.fileField ?? "image", new Blob(["image bytes"]), "test.png");
    if (fields.owner) {
        body.append("user_id", fields.owner);
        body.append("userId", fields.owner);
    }
    return request("/posts", { method: "POST", body }, token);
}

before(async () => {
    const dependencies = {
        pool: { query },
        nodemailer: { createTransport: () => assert.fail("Unexpected email") },
        cloudinary: { uploader: { upload_stream: upload } }
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
        body: { status: "ok", service: "trufind-backend" }
    });
});

test("unauthenticated writes stop before image parsing or database queries", async () => {
    const date = mock.method(Date, "now", () => new Date("2020-01-01").getTime());
    const expired = issueToken(1).token;
    date.mock.restore();
    const tampered = firstUser.token.replace(/^1\./, "2.");
    const extended = expired.replace(/\.\d{13}\./, `.${Date.now() + 3600000}.`);
    const beforeQueries = query.mock.callCount();
    const beforeUploads = upload.mock.callCount();

    for (const token of [undefined, "invalid", tampered, expired, extended]) {
        assert.equal((await createPost(token)).status, 401);
        assert.equal((await createPost(token, { fileField: "unexpected" })).status, 401);
        assert.equal((await request("/delete-posts/1?userId=1", { method: "DELETE" }, token)).status, 401);
    }
    assert.equal(query.mock.callCount(), beforeQueries);
    assert.equal(upload.mock.callCount(), beforeUploads);
});

test("users can create and delete their own posts and supplied IDs are ignored", async () => {
    const id = nextId;
    assert.equal((await createPost(firstUser.token, { owner: "2" })).body.success, true);
    assert.deepEqual(posts.get(id), { owner: "1", image: "https://example.test/image.png" });

    const path = `/delete-posts/${id}`;
    const denied = await request(`${path}?userId=1`, { method: "DELETE" }, secondUser.token);
    assert.equal(denied.status, 404);
    assert.equal(posts.get(id).owner, "1");

    const deleted = await request(`${path}?userId=2`, { method: "DELETE" }, firstUser.token);
    assert.equal(deleted.body.success, true);
    assert.equal(posts.has(id), false);
});

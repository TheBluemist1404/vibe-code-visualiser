// Starts the built API on a free port and walks the enrollment → notification flow over HTTP.
// Usage: npm run build && npm run smoke
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}/api`;
const server = spawn(process.execPath, ["server/dist/main.js"], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "ignore", "inherit"] });

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/courses`);
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const steps = [
    ["GET", "/courses"],
    ["POST", "/enrollments", { studentId: "stu-ada", courseId: "crs-poetry" }],
    ["POST", "/enrollments", { studentId: "stu-bob", courseId: "crs-poetry" }],
    ["GET", "/notifications?recipientId=stu-ada"],
    ["GET", "/notifications?recipientId=stu-bob"],
    ["GET", "/courses"],
  ];
  const results = [];
  for (const [method, path, body] of steps) {
    const r = await call(method, path, body);
    results.push(r);
    console.log(`${method} ${path}${body ? " " + JSON.stringify(body) : ""}\n  → ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal(results[1].body.status, "confirmed");
  assert.deepEqual([results[2].body.status, results[2].body.reason], ["rejected", "COURSE_FULL"]);
  assert.equal(results[3].body[0].kind, "enrollment-confirmed");
  assert.equal(results[4].body[0].kind, "enrollment-rejected");
  assert.equal(results[5].body.find((c) => c.id === "crs-poetry").seatsLeft, 0);
  console.log("smoke: ok");
} finally {
  server.kill();
}

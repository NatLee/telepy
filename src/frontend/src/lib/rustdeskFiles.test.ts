import { test } from "node:test";
import assert from "node:assert/strict";
import { activeJobs, applyJobEvent, crumbsFor, formatBytes, isWindowsPeer, joinRemote, jobPercent, MAX_TRANSFER_BYTES, parentRemote, parseFileDir, withinLimit, type Job } from "./rustdeskFiles.ts";

test("file_dir values become a sorted listing, folders first", () => {
    const d = parseFileDir(JSON.stringify({ id: 0, path: "/home/dev", entries: [
        { entry_type: 4, name: "b.txt", size: 12, modified_time: 1700000000 },
        { entry_type: 0, name: "Zeta", size: 0, modified_time: 0 },
        { entry_type: 5, name: "a-link", size: 3, modified_time: 0 },
        { entry_type: 2, name: "alpha", size: 0, modified_time: 0 },
        { entry_type: 4, name: "..", size: 0, modified_time: 0 },
    ] }))!;
    assert.equal(d.path, "/home/dev");
    assert.deepEqual(d.entries.map((e) => e.name), ["alpha", "Zeta", "a-link", "b.txt"]);
    assert.deepEqual([d.entries[0].isDir, d.entries[0].isLink, d.entries[2].isDir, d.entries[2].isLink], [true, true, false, true]);
    assert.equal(d.entries[3].size, 12);
    assert.equal(parseFileDir("not json"), null);
    assert.equal(parseFileDir({ path: 1 }), null);
});

test("unix paths join, climb and split", () => {
    assert.equal(joinRemote("/home/dev", "a", false), "/home/dev/a");
    assert.equal(joinRemote("/", "etc", false), "/etc");
    assert.equal(parentRemote("/home/dev", false), "/home");
    assert.equal(parentRemote("/home", false), "/");
    assert.equal(parentRemote("/", false), null);
    assert.deepEqual(crumbsFor("/home/dev", false).map((c) => c.path), ["/", "/home", "/home/dev"]);
});

test("windows paths have drives at the top", () => {
    assert.equal(isWindowsPeer("Windows"), true);
    assert.equal(isWindowsPeer("Linux"), false);
    assert.equal(joinRemote("", "C:", true), "C:\\");
    assert.equal(joinRemote("C:\\", "Users", true), "C:\\Users");
    assert.equal(joinRemote("C:\\Users", "me", true), "C:\\Users\\me");
    assert.equal(parentRemote("C:\\Users\\me", true), "C:\\Users");
    assert.equal(parentRemote("C:\\Users", true), "C:\\");
    assert.equal(parentRemote("C:\\", true), "");
    assert.equal(parentRemote("", true), null);
    assert.deepEqual(crumbsFor("C:\\Users\\me", true).map((c) => c.path), ["", "C:\\", "C:\\Users", "C:\\Users\\me"]);
});

test("job events drive progress, overwrite questions and endings", () => {
    let jobs: Job[] = [
        { id: 1, kind: "download", name: "big.iso", total: 1000, done: 0, speed: 0, state: "running", error: null },
        { id: 2, kind: "upload", name: "notes.txt", total: 10, done: 0, speed: 0, state: "running", error: null },
    ];
    jobs = applyJobEvent(jobs, { name: "update_folder_files", info: JSON.stringify({ id: 1, num_entries: 1, total_size: 2000 }) });
    jobs = applyJobEvent(jobs, { name: "job_progress", id: "1", finished_size: "500", speed: "250.0" });
    assert.deepEqual([jobs[0].total, jobs[0].done, jobs[0].speed, jobPercent(jobs[0])], [2000, 500, 250, 25]);
    jobs = applyJobEvent(jobs, { name: "override_file_confirm", id: "2", file_num: "0", is_identical: "false" });
    assert.equal(jobs[1].state, "confirm");
    assert.equal(activeJobs(jobs), 2);
    jobs = applyJobEvent(jobs, { name: "job_error", id: "2", err: "skipped" });
    assert.deepEqual([jobs[1].state, jobs[1].error], ["cancelled", null]);
    jobs = applyJobEvent(jobs, { name: "job_done", id: "1" });
    assert.deepEqual([jobs[0].state, jobPercent(jobs[0])], ["done", 100]);
    jobs = applyJobEvent(jobs, { name: "job_error", id: "1", err: "disk full" });
    assert.equal(jobs[0].error, "disk full");
    assert.equal(applyJobEvent(jobs, { name: "job_done", id: "99" }), jobs, "unknown jobs are ignored");
    assert.equal(activeJobs(jobs), 0);
});

test("size limit and formatting", () => {
    assert.equal(withinLimit(MAX_TRANSFER_BYTES), true);
    assert.equal(withinLimit(MAX_TRANSFER_BYTES + 1), false);
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0 GB");
});

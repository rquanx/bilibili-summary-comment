import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createCliError } from "../../shared/cli/errors";

// Persist intent before POST and its receipt before visibility checks. Unknown
// outcomes must be reconciled rather than submitted again after a restart.
export class CommentSubmissionStore {
  constructor(private readonly root: string) {}

  private file(identity: unknown, suffix = "") {
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    return path.join(this.root, `${key}${suffix}.json`);
  }

  private write(file: string, data: unknown) {
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  async submit(identity: unknown, create: () => Promise<any>) {
    const file = this.file(identity);
    fs.mkdirSync(this.root, { recursive: true });
    try {
      fs.writeFileSync(file, JSON.stringify({ status: "pending" }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const receipt = `${file}.receipt`;
      const previous = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : {};
      if (Number.isSafeInteger(previous.rpid) && previous.rpid > 0) {
        return { replyRes: { rpid: previous.rpid }, warnings: [] };
      }
      throw createCliError("Previous comment submission outcome is unknown; reconcile before resending", { submissionFile: file });
    }
    let result;
    try {
      result = await create();
    } catch (error) {
      // An explicit API rejection confirms no comment was accepted. Transport
      // failures and timeouts have uncertain outcomes and keep their reservation.
      const response = (error as { rawResponse?: { code?: unknown; data?: { code?: unknown } } })?.rawResponse;
      const code = response?.code ?? response?.data?.code;
      if (typeof code === "number" && code < 0) fs.unlinkSync(file);
      throw error;
    }
    const rpid = Number(result.replyRes?.rpid);
    if (!Number.isSafeInteger(rpid) || rpid <= 0) throw createCliError("Comment submission returned no valid receipt");
    this.write(`${file}.receipt`, { status: "submitted", rpid });
    return result;
  }

  async fallback(identity: unknown, resolve: () => Promise<any>) {
    const file = this.file(identity, ".fallback");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    const diagnosis = await resolve();
    fs.mkdirSync(this.root, { recursive: true });
    this.write(file, diagnosis);
    return diagnosis;
  }
}

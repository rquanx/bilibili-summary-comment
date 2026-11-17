import fs from "node:fs/promises";
import { uploadTextToPaste } from "../domains/bili/paste-upload";

const input = process.argv[2];
if (!input) throw new Error("Usage: PRIVATEBIN_URL=https://host node --import tsx src/commands/paste-upload.ts <text-file>");
console.log(await uploadTextToPaste(await fs.readFile(input, "utf8")));

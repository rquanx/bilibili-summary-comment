import { loadDotEnvIfPresent } from "../../../scripts/lib/shared/runtime-tools";
import { buildApiServer } from "./app";

loadDotEnvIfPresent();

const port = Number(process.env.API_PORT ?? 3030) || 3030;
const host = String(process.env.API_HOST ?? "0.0.0.0").trim() || "0.0.0.0";

const app = await buildApiServer({
  logger: true,
});

try {
  await app.listen({
    host,
    port,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

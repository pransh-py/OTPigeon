import { randomBytes } from "node:crypto";
import { MessagingClient } from "otpigeon";
import { MockTransport } from "otpigeon/testing";
import { createGateway, hashApiKey } from "otpigeon/gateway";
// This example is mock-only. Preserve both secrets across gateway restarts.
const key = process.env.OTPIGEON_PROJECT_KEY;
const storageSecret = process.env.OTPIGEON_STORAGE_SECRET;
if (!key || !/^otpg_test_[A-Za-z0-9_-]{32,}$/.test(key) || !storageSecret) {
  console.error("Set persistent secrets first:");
  console.error(
    `export OTPIGEON_PROJECT_KEY=otpg_test_${randomBytes(32).toString("base64url")}`,
  );
  console.error(
    `export OTPIGEON_STORAGE_SECRET=${randomBytes(32).toString("hex")}`,
  );
  process.exitCode = 1;
} else {
  const client = new MessagingClient({ transport: new MockTransport() });
  await client.connect();
  const gateway = await createGateway({
    databasePath:
      process.env.OTPIGEON_DATABASE_PATH ?? ".otpigeon/gateway.sqlite",
    storageSecret,
    projects: [
      { id: "demo", environment: "test", keyHashes: [hashApiKey(key)], client },
    ],
    onError: (error) => console.error(error.code),
  });
  const { port } = await gateway.listen({
    port: Number(process.env.PORT ?? 8080),
  });
  console.log(`Mock gateway: http://127.0.0.1:${port}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void gateway.close().catch((error) => {
        console.error(error.code);
        process.exitCode = 1;
      });
    });
}

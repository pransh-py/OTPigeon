import { connectExample } from "./common.js";
const { client, transport, live } = await connectExample();
const replied = new Promise((resolve, reject) => {
  client.on("message", async (message) => {
    // Only respond to this explicit command. Your application owns consent/routing.
    if (message.text.trim().toLowerCase() !== "status") return;
    try {
      const result = await message.reply("Your order is being prepared.");
      console.log(result);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
if (!live) {
  transport.receive({
    id: "demo-incoming",
    chatId: "12025550123@c.us",
    text: "status",
  });
  await replied;
  await client.close();
} else {
  void replied.catch((error) => console.error(error.code));
  console.log('Send "status" to the linked account. Ctrl+C to stop.');
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void client.close().catch((error) => console.error(error.code));
    });
}

import { connectExample } from "./common.js";
const { client, to } = await connectExample();
try {
  console.log(
    await client.sendText({ to, text: "Order #1042 is ready for collection." }),
  );
  console.log(
    await client.sendImage({
      to,
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=",
        "base64",
      ),
      mimeType: "image/png",
      filename: "order.png",
      caption: "Order #1042",
    }),
  );
  console.log(
    await client.sendDocument({
      to,
      data: Buffer.from("Order #1042\nStatus: Ready for collection\n"),
      mimeType: "text/plain",
      filename: "receipt.txt",
    }),
  );
} finally {
  await client.close();
}

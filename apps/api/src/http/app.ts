import { requestLogger } from "@petrel/logger";
import { Hono } from "hono";
import { notFound, onError } from "./middleware/error.ts";
import { chat } from "./routes/chat.ts";
import { system } from "./routes/system.ts";

export const app = new Hono();

app.use(requestLogger);
app.onError(onError);
app.notFound(notFound);

// 后续路由挂载点：auth · agents · knowledge · dashboard · eval
app.route("/api/system", system);
app.route("/api/chat", chat);

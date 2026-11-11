import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Course Desk API listening on http://localhost:${port}/api`);
}

void bootstrap();

import type { INestApplication } from "@nestjs/common";

/** Shared by main.ts and the e2e tests, so both serve the same routes. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix("api");
  app.enableCors();
  return app;
}

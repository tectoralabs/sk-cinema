import express, { type Express } from 'express';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  return app;
}

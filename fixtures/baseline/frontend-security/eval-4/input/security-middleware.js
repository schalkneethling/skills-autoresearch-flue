import crypto from 'node:crypto';
import helmet from 'helmet';

export function securityMiddleware(app) {
  app.use(helmet());

  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://*.google-analytics.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src *",
        "font-src 'self' https://fonts.googleapis.com",
        "connect-src 'self' https://*.google-analytics.com",
        "frame-src *",
        "base-uri *",
        "form-action *"
      ].join('; ')
    );
    next();
  });
}

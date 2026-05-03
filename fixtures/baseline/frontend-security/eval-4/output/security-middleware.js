import crypto from 'node:crypto';
import helmet from 'helmet';

export function securityMiddleware(app) {
  app.use(helmet());

  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://www.googletagmanager.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "img-src 'self' https://images.example.com data:",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' https://www.google-analytics.com https://analytics.google.com",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests"
      ].join('; ')
    );
    next();
  });
}

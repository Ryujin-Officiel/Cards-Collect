let app;
let initError = null;

try {
  app = require('../src/server');
} catch (err) {
  initError = {
    message: err.message,
    stack: err.stack,
    code: err.code,
  };
  console.error('Fatal initialization error:', err);
}

module.exports = (req, res) => {
  if (initError) {
    return res.status(500).json({
      error: 'Vercel Initialization Error',
      details: initError,
    });
  }
  return app(req, res);
};

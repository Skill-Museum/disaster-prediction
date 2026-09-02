module.exports = {
  apps: [
    {
      name: 'nepal-early-warning',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        // PORT: '3001',          // uncomment to force a port (else uses process.env.PORT or 3000)
        // DISABLE_AGENT: '1',    // set to '1' to skip the web-search agent on restricted hosts
        // REFRESH_MS: '120000'   // set to override the 2-min refresh interval
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
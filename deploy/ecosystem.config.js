// PM2 process config for Card2Leads.
// IMPORTANT: the app keeps state in memory, so it must run as a SINGLE instance
// (fork mode, instances: 1). Do NOT use cluster mode or multiple instances until
// sessions/rate-limits/extraction are moved to Redis + a job queue.
module.exports = {
  apps: [
    {
      name: "card2leads",
      script: "server.js",
      cwd: "/var/www/card2leads",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production"
      },
      // App reads secrets from the .env file in cwd (via dotenv); keep them out of here.
      out_file: "/var/log/card2leads/out.log",
      error_file: "/var/log/card2leads/error.log",
      time: true
    }
  ]
};

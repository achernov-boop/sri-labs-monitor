// PM2 process manager config — for running without Docker
module.exports = {
  apps: [{
    name: 'sri-labs-dashboard',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};

// Multi-screen is the default host runtime. Keeping this tiny entry point lets
// existing launch scripts, systemd units and Docker images continue to invoke
// `node src/host.mjs` while the implementation evolves independently.
import './host-multi.mjs';

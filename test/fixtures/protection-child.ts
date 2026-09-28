import { loadRealGuard } from "./protection-sdk.ts";

const child = await loadRealGuard(process.cwd());
await child.session.bindExtensions({});
process.stdout.write(`${JSON.stringify(child.snapshot())}\n`);
child.session.dispose();

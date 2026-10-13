/** Turns every recorded check into out/report.md (page x role x theme x viewport, pass/fail/blocked). */
import { writeReport } from './lib/report';

export default async function globalTeardown(): Promise<void> {
  const path = writeReport();
  console.log(`hammer report: ${path}`);
}

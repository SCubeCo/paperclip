import fs from "node:fs/promises";
import path from "node:path";

const sourceDir = path.join("src", "onboarding-assets");
const destinationDir = path.join("dist", "onboarding-assets");

async function main() {
  await fs.mkdir(destinationDir, { recursive: true });

  try {
    await fs.cp(sourceDir, destinationDir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}

await main();
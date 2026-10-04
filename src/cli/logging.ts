type LogLevel = "info" | "success" | "warning" | "error";

const levelLabels: Record<LogLevel, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  error: "Error",
};

const levelColors: Record<LogLevel, string> = {
  info: "\u001B[36m",
  success: "\u001B[32m",
  warning: "\u001B[33m",
  error: "\u001B[31m",
};

const resetColor = "\u001B[0m";

/** Writes a line before terminal diagnostics so active spinners stay readable. */
export function writeCliLog(
  level: LogLevel,
  message: string,
  terminalUi: boolean,
): void {
  const indent = "  ";
  const line = `${indent}${levelLabels[level]}: ${message.replaceAll(
    "\n",
    `\n${indent}`,
  )}`;
  if (!terminalUi) {
    console.error(line);
    return;
  }
  const spacing = level === "warning" ? "\n\n" : "\n";
  process.stderr.write(`\n${levelColors[level]}${line}${resetColor}${spacing}`);
}

/**
 * Node writes warnings directly to stderr, which otherwise corrupts an active
 * spinner. Replace its default listener with level-aware CLI output.
 */
export function installProcessWarningLogger(terminalUi: boolean): void {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    const name = warning.name === "Warning" ? "" : `${warning.name}: `;
    writeCliLog("warning", `${name}${warning.message}`, terminalUi);
  });
}

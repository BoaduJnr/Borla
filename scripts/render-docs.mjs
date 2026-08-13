#!/usr/bin/env node
// Renders every docs/*.md file to a matching styled .html file, then prints each to PDF using
// the system-installed Chrome/Edge in headless mode (no Puppeteer/Chromium download needed).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, "../docs");

marked.setOptions({ gfm: true, breaks: false });

const CSS = `
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    line-height: 1.55;
    font-size: 12.5px;
    max-width: 100%;
  }
  h1, h2, h3, h4 { font-family: "Segoe UI", Arial, sans-serif; color: #0a5239; page-break-after: avoid; }
  h1 { font-size: 22px; border-bottom: 3px solid #0e6e4e; padding-bottom: 8px; margin-top: 0; }
  h2 { font-size: 17px; margin-top: 28px; border-bottom: 1px solid #dbd9ce; padding-bottom: 4px; }
  h3 { font-size: 14px; margin-top: 20px; color: #16241c; }
  h4 { font-size: 12.5px; margin-top: 14px; color: #3e4a43; }
  p, li { font-size: 12.5px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 16px; font-size: 11px; page-break-inside: auto; }
  th, td { border: 1px solid #c9c7bb; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #e4f1ea; color: #0a5239; font-family: "Segoe UI", Arial, sans-serif; }
  tr:nth-child(even) td { background: #fafaf6; }
  code { font-family: "Consolas", "Courier New", monospace; background: #f1f0e8; padding: 1px 4px; border-radius: 3px; font-size: 10.5px; }
  pre { background: #16241c; color: #dce7e0; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 10px; line-height: 1.4; page-break-inside: avoid; }
  pre code { background: none; color: inherit; padding: 0; }
  blockquote { border-left: 4px solid #f5a208; margin: 12px 0; padding: 4px 14px; background: #fff1d2; color: #6b4e00; }
  a { color: #0a5239; }
  hr { border: none; border-top: 2px solid #dbd9ce; margin: 24px 0; }
  .cover { text-align: center; padding-top: 20%; page-break-after: always; }
  .cover h1 { font-size: 32px; border: none; }
  .cover .sub { font-size: 15px; color: #3e4a43; margin-top: 6px; }
  .cover .meta { margin-top: 60px; font-size: 13px; line-height: 2; }
  ul, ol { padding-left: 22px; }
  img, svg { max-width: 100%; }
  .badge { display: inline-block; background: #e4f1ea; color: #0a5239; border-radius: 10px; padding: 2px 9px; font-size: 10.5px; font-weight: bold; font-family: Arial, sans-serif; }
`;

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("No Chrome/Edge install found for PDF printing");
}

const files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
const chrome = findChrome();
console.log(`Using browser: ${chrome}`);

for (const file of files) {
  const mdPath = path.join(docsDir, file);
  const md = readFileSync(mdPath, "utf8");
  const bodyHtml = marked.parse(md);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${bodyHtml}</body></html>`;

  const htmlPath = mdPath.replace(/\.md$/, ".html");
  writeFileSync(htmlPath, html, "utf8");

  const pdfPath = mdPath.replace(/\.md$/, ".pdf");
  console.log(`Rendering ${file} -> ${path.basename(pdfPath)}`);
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      "--print-to-pdf-no-header",
      "--no-sandbox",
      `file:///${htmlPath.replace(/\\/g, "/")}`,
    ],
    { stdio: "inherit" }
  );
}

console.log("Done.");

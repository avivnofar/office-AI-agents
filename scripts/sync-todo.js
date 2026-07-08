#!/usr/bin/env node
// Manual, on-demand converter: "TO DO LIST.docx" -> TODO.md
//
// Run this by hand after editing the .docx:
//   node scripts/sync-todo.js
//
// This is NOT wired into any cron/automation. All automation in this repo
// reads TODO.md, never the .docx directly — re-run this script and commit
// the result whenever the .docx changes.
//
// No docx/zip npm dependency: .docx is a plain zip archive, so this reads
// word/document.xml straight out of the zip's central directory (standard
// zip layout, no zip64/encryption support needed for a Word-generated file)
// and inflates it with node:zlib.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCX_PATH = path.join(REPO_ROOT, 'TO DO LIST.docx');
const OUT_PATH = path.join(REPO_ROOT, 'TODO.md');

// Section headers recognized in the source doc, in the order they should
// appear in TODO.md. Add to this list if a new top-level section is added
// to the .docx — anything else is treated as body content under whichever
// section preceded it.
const KNOWN_SECTIONS = [
  'General',
  'AI-office-agents',
  'Notebook-X',
  'Archive-alpha',
  'Archive-Galil-Elion',
  'Data-Center',
];

function readZipEntry(buffer, entryName) {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error(`Not a valid zip/docx file (no EOCD found): ${DOCX_PATH}`);

  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < cdEntries; i++) {
    if (buffer.readUInt32LE(offset) !== CDH_SIG) throw new Error('Malformed zip central directory');
    const compMethod = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (name === entryName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== LFH_SIG) throw new Error('Malformed zip local file header');
      const lhNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const lhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      return compMethod === 0 ? raw : zlib.inflateRawSync(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`Entry not found in ${DOCX_PATH}: ${entryName}`);
}

function docxToPlainText(docxBuffer) {
  const xml = readZipEntry(docxBuffer, 'word/document.xml').toString('utf8');
  const withBreaks = xml.replace(/<\/w:p>/g, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function toMarkdown(plainText) {
  const knownByLower = new Map(KNOWN_SECTIONS.map((s) => [s.toLowerCase(), s]));
  const lines = plainText.split('\n').map((l) => l.trim());
  const out = ['# TO DO LIST', ''];

  for (const line of lines) {
    if (!line || line.toLowerCase() === 'to do list') continue;

    const known = knownByLower.get(line.toLowerCase());
    if (known) {
      if (out[out.length - 1] !== '') out.push('');
      out.push(`## ${known}`, '');
      continue;
    }

    if (/^[-*#]\s*/.test(line)) {
      out.push(`- ${line.replace(/^[-*#]\s*/, '')}`);
    } else {
      out.push(line);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function main() {
  if (!fs.existsSync(DOCX_PATH)) {
    console.error(`Not found: ${DOCX_PATH}`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(DOCX_PATH);
  const markdown = toMarkdown(docxToPlainText(buffer));
  fs.writeFileSync(OUT_PATH, markdown, 'utf8');
  console.log(`Wrote ${OUT_PATH} (${markdown.length} chars)`);
}

main();

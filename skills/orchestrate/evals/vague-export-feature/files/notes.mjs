#!/usr/bin/env node
// notes: a tiny note-taking CLI. Notes live in notes.json beside this file.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FILE = process.env.NOTES_FILE || join(dirname(fileURLToPath(import.meta.url)), 'notes.json');

export function load(file = FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function save(notes, file = FILE) {
  writeFileSync(file, JSON.stringify(notes, null, 2));
}

export function add(notes, text, now = new Date()) {
  const id = notes.length ? Math.max(...notes.map((n) => n.id)) + 1 : 1;
  return [...notes, { id, text, createdAt: now.toISOString() }];
}

export function search(notes, term) {
  return notes.filter((n) => n.text.includes(term));
}

const HELP = `usage: notes <command>
  add <text>      add a note
  list            list all notes
  serach <term>   find notes containing a term`;

function main(argv) {
  const [command, ...rest] = argv;
  const notes = load();
  if (command === 'add') {
    save(add(notes, rest.join(' ')));
    console.log('added');
  } else if (command === 'list') {
    for (const n of notes) console.log(`${n.id}  ${n.text}`);
  } else if (command === 'search') {
    for (const n of search(notes, rest.join(' '))) console.log(`${n.id}  ${n.text}`);
  } else {
    console.log(HELP);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

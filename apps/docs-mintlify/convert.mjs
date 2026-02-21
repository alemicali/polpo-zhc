#!/usr/bin/env node
/**
 * Starlight → Mintlify MDX converter.
 * 
 * Reads all .mdx files from the Starlight docs source, applies format conversions,
 * and writes them to the Mintlify docs directory.
 * 
 * Conversions:
 * - Strip all `import { ... } from '@astrojs/starlight/components';` lines
 * - <Aside> → <Note>, <Aside type="tip"> → <Tip>, <Aside type="caution"> → <Warning>, <Aside type="note"> → <Note>
 * - <TabItem label="..."> → <Tab title="...">, </TabItem> → </Tab>
 * - <Card ...> → plain markdown (Mintlify doesn't have Card/CardGrid)
 * - Frontmatter: keep title + description, strip hero: and everything else Starlight-specific
 * - <Steps> stays as-is (same in Mintlify)
 * - <Tabs> stays as-is (same in Mintlify)
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC = './apps/docs/src/content/docs';
const DEST = './apps/docs-mintlify';

// All files to convert (relative to SRC)
const FILES = [
  'introduction.mdx',
  'getting-started.mdx',
  'configuration.mdx',
  'guides/first-plan.mdx',
  'concepts/architecture.mdx',
  'concepts/agents-and-teams.mdx',
  'concepts/task-lifecycle.mdx',
  'concepts/plans.mdx',
  'concepts/providers-and-models.mdx',
  'features/tools-and-mcp.mdx',
  'features/skills.mdx',
  'features/templates.mdx',
  'features/assessment.mdx',
  'features/hooks.mdx',
  'features/notifications.mdx',
  'features/approval-gates.mdx',
  'features/escalation.mdx',
  'features/scheduling.mdx',
  'features/sessions.mdx',
  'features/memory.mdx',
  'features/deadlock-resolution.mdx',
  'features/question-detection.mdx',
  'features/resilience.mdx',
  'features/security.mdx',
  'features/writing-templates.mdx',
  'usage/cli.mdx',
  'usage/tui.mdx',
  'usage/server.mdx',
  'usage/web-ui.mdx',
  'reference/config.mdx',
  'reference/api.mdx',
  'reference/events.mdx',
  'reference/react-sdk.mdx',
  'reference/adapters.mdx',
  'reference/custom-adapter.mdx',
  'reference/store-backends.mdx',
  'reference/coding-tools.mdx',
];

function convertFrontmatter(content) {
  // Extract frontmatter
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return content;

  const fm = match[1];
  const lines = fm.split('\n');

  // Keep only title and description from frontmatter
  let title = '';
  let description = '';
  let inHero = false;
  let heroIndent = 0;

  for (const line of lines) {
    if (line.startsWith('hero:')) {
      inHero = true;
      heroIndent = 0;
      continue;
    }
    if (inHero) {
      // Skip all hero sub-fields
      if (line.match(/^\s/) || line.trim() === '') continue;
      inHero = false;
    }

    const titleMatch = line.match(/^title:\s*(.+)/);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
    }

    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, '');
    }
  }

  let newFm = '---\n';
  newFm += `title: "${title}"\n`;
  if (description) {
    newFm += `description: "${description}"\n`;
  }
  newFm += '---';

  return content.replace(/^---\n[\s\S]*?\n---/, newFm);
}

function stripImports(content) {
  // Remove all import lines from starlight components
  return content.replace(/^import\s+\{[^}]+\}\s+from\s+['"]@astrojs\/starlight\/components['"];?\s*\n?/gm, '');
}

function convertAside(content) {
  // <Aside type="tip"> → <Tip>
  content = content.replace(/<Aside\s+type=["']tip["']\s*>/g, '<Tip>');
  // <Aside type="caution"> → <Warning>
  content = content.replace(/<Aside\s+type=["']caution["']\s*>/g, '<Warning>');
  // <Aside type="note"> → <Note>
  content = content.replace(/<Aside\s+type=["']note["']\s*>/g, '<Note>');
  // <Aside type="danger"> → <Warning>
  content = content.replace(/<Aside\s+type=["']danger["']\s*>/g, '<Warning>');
  // Plain <Aside> (no type) → <Note>
  content = content.replace(/<Aside>/g, '<Note>');

  // Closing tags: need to match the correct opening
  // Strategy: go line by line, track which Aside variant we're in
  // Simpler: replace </Aside> based on what the nearest opening was
  // Since we've already converted opening tags, we just need to map </Aside> to the right closing

  // Actually, after the above replacements, there should be no more <Aside> tags.
  // All </Aside> need to become the matching closing tag.
  // We'll do a stateful replacement.

  const lines = content.split('\n');
  const tagStack = [];
  const result = [];

  for (const line of lines) {
    let processedLine = line;

    // Check for opening tags
    if (processedLine.includes('<Tip>')) tagStack.push('Tip');
    if (processedLine.includes('<Warning>')) tagStack.push('Warning');
    if (processedLine.includes('<Note>')) tagStack.push('Note');
    if (processedLine.includes('<Info>')) tagStack.push('Info');

    // Replace </Aside> with matching closing tag
    if (processedLine.includes('</Aside>')) {
      const tag = tagStack.pop() || 'Note';
      processedLine = processedLine.replace('</Aside>', `</${tag}>`);
    }

    result.push(processedLine);
  }

  return result.join('\n');
}

function convertTabs(content) {
  // <TabItem label="..."> → <Tab title="...">
  content = content.replace(/<TabItem\s+label=["']([^"']+)["']\s*>/g, '<Tab title="$1">');
  // </TabItem> → </Tab>
  content = content.replace(/<\/TabItem>/g, '</Tab>');
  return content;
}

function convertCards(content) {
  // Convert <CardGrid> → remove (just a wrapper)
  content = content.replace(/<CardGrid>/g, '');
  content = content.replace(/<\/CardGrid>/g, '');

  // Convert <Card title="..." icon="..."> ... </Card> → ### title \n content
  // This is a simplification since Mintlify uses <Card> differently
  // Actually Mintlify DOES have <Card> and <CardGroup> — let's convert to Mintlify format
  // Mintlify Card: <Card title="..." icon="..." href="...">content</Card>
  // Mintlify CardGroup: <CardGroup cols={2}>...</CardGroup>

  // Replace <CardGrid> with <CardGroup cols={2}>
  // Actually we already stripped them. Let me redo:
  // First pass: let's just keep Card as-is and wrap groups

  // Actually, the simplest approach: Mintlify Cards work similarly enough.
  // The icon names might differ. Let's keep the content and just note it.
  // Mintlify uses heroicons, Starlight uses different icon sets.
  // For now, strip icons since they won't match.

  // <Card title="..." icon="..."> → <Card title="...">
  content = content.replace(/<Card\s+title=["']([^"']+)["']\s+icon=["'][^"']*["']\s*>/g, '<Card title="$1">');

  return content;
}

function convertHeroPage(content) {
  // The introduction page has a hero section in frontmatter.
  // We've already stripped it in convertFrontmatter.
  // Now add a hero-like section at the top of the body.
  if (!content.includes('Meet Polpo')) {
    return content;
  }

  // The intro page already has the content after the hero.
  // We just need to add a nice header since the hero is gone.
  // Actually the content below the frontmatter already has good structure,
  // so just ensure there's a good opening. Let's add a subtitle.

  // Insert after frontmatter closing
  const fmEnd = content.indexOf('---', content.indexOf('---') + 3);
  if (fmEnd === -1) return content;

  const afterFm = content.slice(fmEnd + 3).trimStart();

  // Check if the page references polpo-octopus.svg image
  // We don't need to handle that for Mintlify — it's a frontmatter-only thing

  return content;
}

function fixLinks(content) {
  // Starlight uses /path/ with trailing slashes. Mintlify uses /path without.
  // Convert markdown links: [text](/path/) → [text](/path)
  content = content.replace(/\]\(\/([^)]+?)\/\)/g, ']($1)');

  // Also fix absolute links starting with / to be relative
  // Actually Mintlify navigation uses relative paths. Let's keep them as-is
  // but strip leading / since Mintlify docs.json uses paths without leading /
  // Actually for markdown links, Mintlify supports both. Let's leave as-is.

  // Re-add the / prefix since we stripped it
  content = content.replace(/\]\(([a-z])/g, '](/$1');

  return content;
}

function convertFile(relPath) {
  const srcPath = join(SRC, relPath);
  const destPath = join(DEST, relPath);

  if (!existsSync(srcPath)) {
    console.warn(`SKIP (not found): ${srcPath}`);
    return false;
  }

  let content = readFileSync(srcPath, 'utf-8');

  // Apply conversions in order
  content = convertFrontmatter(content);
  content = stripImports(content);
  content = convertAside(content);
  content = convertTabs(content);
  content = convertCards(content);
  content = fixLinks(content);

  // Clean up multiple blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  // Ensure directory exists
  mkdirSync(dirname(destPath), { recursive: true });

  writeFileSync(destPath, content, 'utf-8');
  console.log(`OK: ${relPath}`);
  return true;
}

// Run conversion
console.log('Converting Starlight MDX → Mintlify MDX...\n');

let ok = 0;
let fail = 0;

for (const file of FILES) {
  if (convertFile(file)) {
    ok++;
  } else {
    fail++;
  }
}

// Copy logo assets
const logoSrc = './apps/docs/src/assets';
const logoDest = DEST;

for (const logo of ['logo.svg', 'logo-dark.svg']) {
  const src = join(logoSrc, logo);
  const dest = join(logoDest, logo);
  if (existsSync(src)) {
    copyFileSync(src, dest);
    console.log(`LOGO: ${logo}`);
  } else {
    console.warn(`LOGO SKIP: ${src} not found`);
  }
}

console.log(`\nDone: ${ok} converted, ${fail} skipped`);

/**
 * Tests for the top-level `services` (sidecar) + `containerTemplateFiles`
 * fields on recipes.
 *
 * Recipe loader is build-tooling-agnostic: it validates the shape but
 * doesn't substitute env vars into these fields at runtime.  Tests cover
 * the validator (accept/reject) AND the loader's pass-through behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecipe, substituteEnvVars, validateRecipe, type Recipe } from '../src/recipe.js';

function recipeWith(services: unknown): unknown {
  return {
    name: 'Test',
    agent: { systemPrompt: 'x' },
    services,
  };
}

describe('services (sidecars) — accept', () => {
  test('minimal sidecar (name + image) validates', () => {
    const r = validateRecipe(recipeWith([{ name: 'mariadb', image: 'mariadb:11' }]));
    expect(r.services?.[0]?.name).toBe('mariadb');
  });

  test('full-shape sidecar with all fields validates', () => {
    const r = validateRecipe(recipeWith([{
      name: 'mediawiki',
      image: 'mediawiki:1.42',
      ports: ['${MW_BIND:-127.0.0.1}:8080:80'],
      volumes: [
        { source: './wiki-db', target: '/var/lib/mysql' },
        { source: './LocalSettings.php', target: '/var/www/html/LocalSettings.php', readOnly: true },
      ],
      environment: { MW_DEBUG: '0' },
      secrets: ['WIKI_DB_PASSWORD'],
      dependsOn: ['mariadb'],
      restart: 'unless-stopped',
      healthcheck: {
        test: ['CMD', 'curl', '-f', 'http://localhost/'],
        interval: '30s',
        timeout: '5s',
        retries: 3,
        startPeriod: '60s',
      },
      templateFiles: [
        { path: './LocalSettings.php', template: '<?php\n$wgSitename = "${WIKI_NAME}";\n', mode: '0644' },
      ],
    }]));
    const svc = r.services?.[0]!;
    expect(svc.image).toBe('mediawiki:1.42');
    expect(svc.dependsOn).toEqual(['mariadb']);
    expect(svc.healthcheck?.retries).toBe(3);
    expect(svc.templateFiles?.[0]?.path).toBe('./LocalSettings.php');
  });

  test('no services field is allowed (services is optional)', () => {
    const r = validateRecipe({ name: 'X', agent: { systemPrompt: 'x' } });
    expect(r.services).toBeUndefined();
  });

  test('empty services array is allowed', () => {
    const r = validateRecipe(recipeWith([]));
    expect(r.services).toEqual([] as Recipe['services']);
  });
});

describe('services — reject', () => {
  test('non-array services rejects', () => {
    expect(() => validateRecipe(recipeWith('nope'))).toThrow('services must be an array');
  });

  test('non-object service entry rejects', () => {
    expect(() => validateRecipe(recipeWith(['just a string']))).toThrow('services[0] must be an object');
  });

  test('uppercase name rejects (compose names must be lowercase identifiers)', () => {
    expect(() => validateRecipe(recipeWith([{ name: 'BAD-CAPS', image: 'a' }]))).toThrow(/lowercase identifier/);
  });

  test('missing image rejects', () => {
    expect(() => validateRecipe(recipeWith([{ name: 'a' }]))).toThrow('services[0].image must be a non-empty string');
  });

  test('duplicate service names reject', () => {
    expect(() => validateRecipe(recipeWith([
      { name: 'svc', image: 'a' }, { name: 'svc', image: 'b' },
    ]))).toThrow('services[1].name "svc" is duplicated');
  });

  test('volume missing source rejects', () => {
    expect(() => validateRecipe(recipeWith([
      { name: 'a', image: 'b', volumes: [{ target: '/x' }] },
    ]))).toThrow(/volumes\[0\].source/);
  });

  test('non-string env value rejects', () => {
    expect(() => validateRecipe(recipeWith([
      { name: 'a', image: 'b', environment: { K: 42 } },
    ]))).toThrow(/environment.K must be a string/);
  });

  test('invalid restart policy rejects', () => {
    expect(() => validateRecipe(recipeWith([
      { name: 'a', image: 'b', restart: 'sometimes' },
    ]))).toThrow(/restart must be one of/);
  });

  test('templateFile bad mode rejects', () => {
    expect(() => validateRecipe(recipeWith([
      { name: 'a', image: 'b', templateFiles: [{ path: 'p', template: 't', mode: '999' }] },
    ]))).toThrow(/mode must be an octal string/);
  });

  test('duplicate template paths within one service reject', () => {
    expect(() => validateRecipe(recipeWith([
      {
        name: 'a',
        image: 'b',
        // Two templates with the same path; volumes also lists it so we
        // pass the cross-check, then hit the dup-path check.
        volumes: [{ source: './p.conf', target: '/etc/p.conf' }],
        templateFiles: [
          { path: './p.conf', template: 'a' },
          { path: './p.conf', template: 'b' },
        ],
      },
    ]))).toThrow(/templateFiles\[1\].path "\.\/p\.conf" is duplicated/);
  });

  test('healthcheck with non-array test rejects', () => {
    expect(() => validateRecipe(recipeWith([
      { name: 'a', image: 'b', healthcheck: { test: 'curl localhost' } },
    ]))).toThrow(/healthcheck.test must be an array of strings/);
  });

  test('sidecar templateFile.path must appear in volumes[].source', () => {
    // Renders to a path the sidecar never bind-mounts → the file would be
    // invisible to the container.  Validator catches this.
    expect(() => validateRecipe(recipeWith([
      {
        name: 'mediawiki',
        image: 'mediawiki:1',
        // No volumes — but a templateFile pointing at a config file.
        templateFiles: [
          { path: './LocalSettings.php', template: '<?php // ...' },
        ],
      },
    ]))).toThrow(/has no matching entry in services\[0\].volumes\[\].source/);
  });

  test('sidecar templateFile is happy when volumes references it', () => {
    expect(() => validateRecipe(recipeWith([
      {
        name: 'mediawiki',
        image: 'mediawiki:1',
        volumes: [
          { source: './LocalSettings.php', target: '/var/www/html/LocalSettings.php', readOnly: true },
        ],
        templateFiles: [
          { path: './LocalSettings.php', template: '<?php // ...' },
        ],
      },
    ]))).not.toThrow();
  });

  test('sidecar templateFile cross-check normalizes ./foo vs foo', () => {
    // Operator typed `./LocalSettings.php` in volumes[].source but
    // `LocalSettings.php` in templateFiles[].path (or vice-versa).  These
    // are semantically the same path; the validator should accept it.
    expect(() => validateRecipe(recipeWith([
      {
        name: 'mediawiki',
        image: 'mediawiki:1',
        volumes: [
          { source: './LocalSettings.php', target: '/var/www/html/LocalSettings.php', readOnly: true },
        ],
        templateFiles: [
          { path: 'LocalSettings.php', template: '<?php // ...' },
        ],
      },
    ]))).not.toThrow();

    expect(() => validateRecipe(recipeWith([
      {
        name: 'mediawiki',
        image: 'mediawiki:1',
        volumes: [
          { source: 'LocalSettings.php', target: '/var/www/html/LocalSettings.php', readOnly: true },
        ],
        templateFiles: [
          { path: './LocalSettings.php', template: '<?php // ...' },
        ],
      },
    ]))).not.toThrow();
  });

  test('duplicate templateFile paths reject across ./ vs no-prefix forms', () => {
    // Should also catch the dedup case under normalization.
    expect(() => validateRecipe(recipeWith([
      {
        name: 'a',
        image: 'b',
        volumes: [{ source: './p.conf', target: '/etc/p.conf' }],
        templateFiles: [
          { path: './p.conf', template: 'a' },
          { path: 'p.conf', template: 'b' },
        ],
      },
    ]))).toThrow(/duplicated/);
  });
});

describe('containerTemplateFiles (top-level) — accept', () => {
  test('full-shape entry validates', () => {
    const r = validateRecipe({
      name: 'X',
      agent: { systemPrompt: 'x' },
      containerTemplateFiles: [{
        hostPath: './mediawiki-mcp-config.json',
        inContainer: '/app/mediawiki-mcp-config.json',
        template: '{ "wikis": {} }',
        mode: '0600',
      }],
    });
    expect(r.containerTemplateFiles?.[0]?.inContainer).toBe('/app/mediawiki-mcp-config.json');
  });
});

describe('containerTemplateFiles — reject', () => {
  test('non-array rejects', () => {
    expect(() => validateRecipe({
      name: 'X', agent: { systemPrompt: 'x' }, containerTemplateFiles: 'nope',
    })).toThrow('containerTemplateFiles must be an array');
  });

  test('missing hostPath rejects', () => {
    expect(() => validateRecipe({
      name: 'X', agent: { systemPrompt: 'x' },
      containerTemplateFiles: [{ inContainer: '/x', template: 't' }],
    })).toThrow(/hostPath must be a non-empty string/);
  });

  test('missing inContainer rejects (it is required at the top level)', () => {
    expect(() => validateRecipe({
      name: 'X', agent: { systemPrompt: 'x' },
      containerTemplateFiles: [{ hostPath: './c', template: 't' }],
    })).toThrow(/inContainer must be a non-empty string/);
  });

  test('typo on top-level templateFiles is caught with a clear message', () => {
    expect(() => validateRecipe({
      name: 'X', agent: { systemPrompt: 'x' },
      // common author mistake — used `templateFiles` (the per-sidecar name)
      // at the top level instead of `containerTemplateFiles`.
      templateFiles: [{ hostPath: './c', inContainer: '/c', template: 't' }],
    })).toThrow(/top-level `templateFiles` is not a valid field/);
  });
});

describe('substituteEnvVars — $$ escape', () => {
  test('"$$" emits a literal "$"', () => {
    expect(substituteEnvVars('$$', 't')).toBe('$');
    expect(substituteEnvVars('A$$B', 't')).toBe('A$B');
  });

  test('"$${VAR}" emits the literal "${VAR}" (no substitution)', () => {
    process.env.SUBST_TEST = 'wrong';
    try {
      expect(substituteEnvVars('$${SUBST_TEST}', 't')).toBe('${SUBST_TEST}');
    } finally {
      delete process.env.SUBST_TEST;
    }
  });

  test('mixed escape and substitution in one string', () => {
    process.env.HOST = 'example.com';
    try {
      expect(substituteEnvVars('host=${HOST} dollars=$$5', 't'))
        .toBe('host=example.com dollars=$5');
    } finally {
      delete process.env.HOST;
    }
  });
});

describe('loadRecipe + services pass-through', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'conhost-services-')); });
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  test('loadRecipe does NOT eagerly substitute service template bodies', async () => {
    // Recipe has a sidecar templateFile referencing a var that isn't in
    // process.env.  If substituteEnvVars (mis-)recursed into services, this
    // would throw "WIKI_DB_PASSWORD which is not set".  Loader must skip.
    delete process.env.WIKI_DB_PASSWORD;
    const recipePath = join(tmpDir, 'r.json');
    writeFileSync(recipePath, JSON.stringify({
      name: 'WithSidecar',
      agent: { systemPrompt: 'x' },
      services: [{
        name: 'mariadb',
        image: 'mariadb:11',
        volumes: [{ source: './my.cnf', target: '/etc/mysql/my.cnf' }],
        templateFiles: [{
          path: './my.cnf',
          template: '[mysqld]\npassword=${WIKI_DB_PASSWORD}\n',
        }],
      }],
    }));
    const r = await loadRecipe(recipePath);
    // Template body survives load with the literal `${WIKI_DB_PASSWORD}` intact.
    const tf = r.services?.[0]?.templateFiles?.[0]?.template;
    expect(tf).toBe('[mysqld]\npassword=${WIKI_DB_PASSWORD}\n');
  });

  test('loadRecipe does NOT eagerly substitute containerTemplateFiles bodies', async () => {
    delete process.env.WIKI_BOT_PASSWORD;
    const recipePath = join(tmpDir, 'r.json');
    writeFileSync(recipePath, JSON.stringify({
      name: 'WithCT',
      agent: { systemPrompt: 'x' },
      containerTemplateFiles: [{
        hostPath: './mwconfig.json',
        inContainer: '/app/mwconfig.json',
        template: '{ "password": "${WIKI_BOT_PASSWORD}" }',
      }],
    }));
    const r = await loadRecipe(recipePath);
    expect(r.containerTemplateFiles?.[0]?.template).toBe('{ "password": "${WIKI_BOT_PASSWORD}" }');
  });

  test('loadRecipe still substitutes mcpServers env values (the contract is unchanged)', async () => {
    process.env.SOME_TOKEN = 'real-value';
    try {
      const recipePath = join(tmpDir, 'r.json');
      writeFileSync(recipePath, JSON.stringify({
        name: 'X',
        agent: { systemPrompt: 'x' },
        mcpServers: {
          srv: { command: 'foo', env: { THE_TOKEN: '${SOME_TOKEN}' } },
        },
      }));
      const r = await loadRecipe(recipePath);
      expect(r.mcpServers?.srv?.env?.THE_TOKEN).toBe('real-value');
    } finally {
      delete process.env.SOME_TOKEN;
    }
  });
});

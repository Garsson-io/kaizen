import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_TERMINAL_ACTIONS,
  VERDICT_BINDING_INVENTORY,
  findInventoryViolations,
  renderVerdictBindingInventoryMarkdown,
} from './verdict-binding-inventory.js';

describe('verdict binding inventory (#1227)', () => {
  it('covers the terminal actions named by #1227', () => {
    const actionIds = new Set(VERDICT_BINDING_INVENTORY.terminalActions.map((a) => a.id));
    for (const action of REQUIRED_TERMINAL_ACTIONS) {
      expect(actionIds.has(action)).toBe(true);
    }
  });

  it('flags computed verdicts that have no terminal enforcing consumer', () => {
    const broken = {
      ...VERDICT_BINDING_INVENTORY,
      computedVerdicts: [
        ...VERDICT_BINDING_INVENTORY.computedVerdicts,
        {
          id: 'unbound-test-verdict',
          label: 'Unbound test verdict',
          producer: 'test fixture',
          terminalCritical: true,
        },
      ],
    };

    expect(findInventoryViolations(broken)).toContain(
      'computed verdict "unbound-test-verdict" has no enforcing terminal consumer',
    );
  });

  it('has no unbound computed verdicts and no source-evidence drift', () => {
    expect(findInventoryViolations(VERDICT_BINDING_INVENTORY)).toEqual([]);
  });

  it('keeps the docs table generated from the same inventory schema', () => {
    const doc = readFileSync('docs/verdict-binding-inventory.md', 'utf8');
    expect(doc).toContain(renderVerdictBindingInventoryMarkdown(VERDICT_BINDING_INVENTORY));
  });

  it('escapes markdown table metacharacters in generated docs cells', () => {
    const rendered = renderVerdictBindingInventoryMarkdown({
      computedVerdicts: [
        {
          id: 'v',
          label: 'Verdict',
          producer: 'test',
          terminalCritical: true,
        },
      ],
      terminalActions: [
        {
          id: 'a',
          label: 'A | B \\ C',
          terminalAction: 'terminal',
          consumedVerdicts: ['v'],
          enforcingConsumer: 'consumer | helper \\ path',
          failureModeBlocked: 'line 1\nline 2',
          sourceEvidence: [],
        },
      ],
    });

    expect(rendered).toContain('A \\| B \\\\ C');
    expect(rendered).toContain('consumer \\| helper \\\\ path');
    expect(rendered).toContain('line 1<br>line 2');
  });
});

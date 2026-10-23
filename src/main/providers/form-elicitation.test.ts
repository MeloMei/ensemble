import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '../../shared/types';
import { answerFormElicitation } from './form-elicitation';
import type { TurnContext } from './types';

test('form choices retain original values when duplicate and suffixed labels collide', async () => {
  const choices = [{ const: 'first', title: 'Route' }, { const: 'second', title: 'Route' }, { const: 'third', title: 'Route (1)' }];
  const schema = { type: 'object', properties: {
    route: { type: 'string', oneOf: choices },
    scope: { type: 'array', items: { anyOf: choices }, minItems: 1 },
  }, required: ['route', 'scope'] };
  const context: TurnContext = {
    session: {} as Session, prompt: '', signal: new AbortController().signal, emit() {},
    approve: async input => {
      const [route, scope] = input.questions!;
      for (const question of [route, scope]) assert.equal(new Set(question.options.map(option => option.label)).size, 3);
      return JSON.stringify({ [route.id]: [route.options[2].label], [scope.id]: scope.options.map(option => option.label) });
    },
  };
  assert.deepEqual(await answerFormElicitation(schema, 'Question', 'Choose route', context), {
    action: 'accept', content: { route: 'third', scope: ['first', 'second', 'third'] },
  });
});

test('optional form choices remain distinct from the omission action and its suffixed labels', async () => {
  const schema = { type: 'object', properties: { route: { type: 'string', oneOf: [
    { const: 'provided', title: '（不提供）' }, { const: 'suffixed', title: '（不提供） (1)' },
  ] } } };
  const context: TurnContext = {
    session: {} as Session, prompt: '', signal: new AbortController().signal, emit() {},
    approve: async input => {
      const question = input.questions![0];
      assert.equal(new Set(question.options.map(option => option.label)).size, 3);
      return JSON.stringify({ [question.id]: [question.options[0].label] });
    },
  };
  assert.deepEqual(await answerFormElicitation(schema, 'Question', 'Choose route', context), {
    action: 'accept', content: { route: 'provided' },
  });
  context.approve = async input => JSON.stringify({ [input.questions![0].id]: ['（不提供）'] });
  assert.deepEqual(await answerFormElicitation(schema, 'Question', 'Choose route', context), { action: 'accept', content: {} });
});

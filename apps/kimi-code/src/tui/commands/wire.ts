/**
 * `/wire` — switch the wire dialect every managed Kimi Code model uses.
 *
 * The Kimi Code API serves the same models over chat completions, the OpenAI
 * Responses API, and the Anthropic Messages API. The choice is stored as
 * `wire_protocol` on the `managed:kimi-code` provider record and re-stamped
 * onto every model alias by the model refresh, so it survives later refreshes.
 */

import {
  MANAGED_KIMI_WIRE_PROTOCOLS,
  type ManagedKimiWireProtocol,
} from '@moonshot-ai/kimi-code-oauth';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import {
  compareEnumArg,
  currentWireProtocol,
  managedProvider,
  managedProviderConfigPatch,
  wireProtocolNames,
  wireProtocolRoute,
} from '#/utils/managed-endpoint';
import type { SlashCommandHost } from './dispatch';
import { refreshAfterSwitch } from './provider';

const WIRE_USAGE = `Usage: /wire [${MANAGED_KIMI_WIRE_PROTOCOLS.join('|')}]`;

export async function handleWireCommand(host: SlashCommandHost, rawArgs = ''): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  if (args.length > 1) {
    host.showError(WIRE_USAGE);
    return;
  }
  if (args[0] === undefined) {
    await showWireToggle(host);
    return;
  }
  const target = compareEnumArg(args[0]!, MANAGED_KIMI_WIRE_PROTOCOLS);
  if (target === undefined) {
    host.showError(`Unknown wire protocol "${args[0]}". ${WIRE_USAGE}`);
    return;
  }
  await applyWireProtocol(host, target);
}

function wireLabel(protocol: ManagedKimiWireProtocol): string {
  if (protocol === 'chat') return 'Chat · POST /chat/completions';
  if (protocol === 'responses') return 'Responses · POST /responses';
  return 'Messages · POST /messages?beta=true';
}

async function showWireToggle(host: SlashCommandHost): Promise<void> {
  let provider;
  try {
    provider = managedProvider(await host.harness.getConfig());
  } catch (error) {
    host.showError(`Failed to read config: ${formatErrorMessage(error)}`);
    return;
  }
  if (provider === undefined) {
    host.showError('No Kimi Code login yet — run /login first.');
    return;
  }
  const current = currentWireProtocol(provider);
  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: 'Kimi Code wire protocol',
      hint: '↑↓ navigate · Enter switch · Esc cancel',
      currentValue: current,
      options: wireProtocolNames().map((protocol) => ({
        value: protocol,
        label: wireLabel(protocol),
        description:
          protocol === 'responses'
            ? 'OpenAI Responses API — streaming event deltas, best for this endpoint.'
            : protocol === 'messages'
              ? 'Anthropic Messages API (beta).'
              : 'OpenAI-compatible chat completions.',
      })),
      onSelect: (value) => {
        const target = compareEnumArg(value, MANAGED_KIMI_WIRE_PROTOCOLS);
        if (target !== undefined) void applyWireProtocol(host, target);
      },
      onCancel: () => {
        host.restoreEditor();
        host.showStatus('Kimi Code wire protocol unchanged.');
      },
    }),
  );
}

async function applyWireProtocol(
  host: SlashCommandHost,
  target: ManagedKimiWireProtocol,
): Promise<void> {
  host.restoreEditor();
  let config;
  try {
    config = await host.harness.getConfig();
  } catch (error) {
    host.showError(`Failed to read config: ${formatErrorMessage(error)}`);
    return;
  }
  const provider = managedProvider(config);
  if (provider === undefined) {
    host.showError('No Kimi Code login yet — run /login first.');
    return;
  }
  if (currentWireProtocol(provider) === target) {
    host.showStatus(`Kimi Code wire protocol is already ${target}.`);
    return;
  }

  const spinner = host.showProgressSpinner(`Switching to ${target}…`);
  try {
    await host.harness.setConfig(
      managedProviderConfigPatch(config, { ...provider, wireProtocol: target }),
    );
  } catch (error) {
    spinner.stop({ ok: false, label: 'Wire protocol switch failed.' });
    host.showError(formatErrorMessage(error));
    return;
  }
  host.showStatus(`Kimi Code wire protocol: ${target} (POST ${wireProtocolRoute(target)})`);
  await refreshAfterSwitch(host, spinner);
}

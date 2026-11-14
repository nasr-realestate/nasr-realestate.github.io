// Exclusions are private configuration, not customer names in the repository.
import { cleanBidiControls } from './crm-chat-intel.js';

function normalized(value) {
  return cleanBidiControls(value).normalize('NFKC').replaceAll(/[\u064b-\u065f\u0670\u0640]/g, '');
}

export function matchesNamedAntixExclusion(value, excludedNames = []) {
  const name = normalized(value);
  return excludedNames.some(term => {
    const words = normalized(term).match(/[\p{L}\p{N}]+/gu) || [];
    if (!words.length) return false;
    const escaped = words.map(word => word.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}]+')}(?=$|[^\\p{L}\\p{N}])`, 'u').test(name);
  });
}

export function isExcludedAntixName(value, excludedNames = []) {
  return normalized(value).includes('🌀') || matchesNamedAntixExclusion(value, excludedNames);
}

export function isProtectedAntixOwner(value, excludedNames = []) {
  const name = cleanBidiControls(value);
  return isExcludedAntixName(name, excludedNames) || /^TEST ONLY/i.test(name.trimStart());
}

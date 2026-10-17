import { waitForEmulators } from './support/emulators';

export default async function setup(): Promise<void> {
  await waitForEmulators();
}

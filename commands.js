import 'dotenv/config';
import { capitalize, InstallGlobalCommands } from './utils.js';

const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const GAG_COMMAND = {
  name: 'gag',
  description: 'Vote to temporarily mute a member of your current voice channel',
  options: [
    {
      type: 6,
      name: 'user',
      description: 'Choose the user to mute',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0],
  contexts: [0],
}

const ALL_COMMANDS = [GAG_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);

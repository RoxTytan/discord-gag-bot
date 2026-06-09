import 'dotenv/config';
import express from 'express';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { getRandomEmoji, DiscordRequest, getVoiceState } from './utils.js';
import { resolveVote } from './gag.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

const activeGames = {};
const activeVotes = {};

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    // "test" command
    if (name === 'test') {
      // Send a message into the channel where command was triggered from
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              // Fetches a random emoji to send from a helper function
              content: `hello world ${getRandomEmoji()}`
            }
          ]
        },
      });
    }

    if (name === 'gag' && id) {
      const context  = req.body.context;
      const invokingUserId = context === 0 ? req.body.member.user.id : req.body.user.id;
      const targetUserId = req.body.data.options[0].value;
      const guildId = req.body.guild_id ?? req.body.guild?.id;

      // Need to be in a server
      if (!guildId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [{
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: 'This command only works in a server.',
            }],
          },
        })
      }

      // Can't start a vote if one already exists
      const existingVote = Object.values(activeVotes).find(v => v.guildId === guildId);
      if (existingVote) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [{
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: `There's already an active vote against <@${targetUserId}>.`,
            }],
          },
        });
      }

      // Can't gag yourself
      if (targetUserId === invokingUserId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [{
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: "You can't gag yourself.",
            }],
          },
        });
      }

      // Get both users' voice states
      const [callerVS, targetVS] = await Promise.all([
        getVoiceState(guildId, invokingUserId),
        getVoiceState(guildId, targetUserId),
      ]);

      // Need to be in a VC
      if (!callerVS?.channel_id) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [{
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: 'You need to be in a voice channel to use this command.',
            }],
          },
        });
      }

      // Person you're gagging needs to be in the same VC
      if (callerVS.channel_id !== targetVS?.channel_id) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [{
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: "That user isn't in your voice channel.",
            }],
          },
        });
      }

      // Finally, both users are confirmed in the same VC
      const voteId = req.body.id;
      activeVotes[voteId] = {
        targetUserId,
        guildId,
        channelId: callerVS.channel_id,
        yesVoters: new Set(),
        noVoters: new Set(),
        startedAt: Date.now(),
      };
      // Start the timer
      setTimeout(() => resolveVote(voteId, req.body.token, req.body.application_id ?? process.env.APP_ID, activeVotes), 60_000);

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [{
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `<@${invokingUserId}> wants to gag <@${targetUserId}>.`,
          },
          {
                type: MessageComponentTypes.ACTION_ROW,
                components: [
                  {
                    type: MessageComponentTypes.BUTTON,
                    custom_id: `yes_button_${voteId}`,
                    label: 'Vote Yes',
                    style: ButtonStyleTypes.SUCCESS,
                  },
                  {
                    type: MessageComponentTypes.BUTTON,
                    custom_id: `no_button_${voteId}`,
                    label: 'Vote No',
                    style: ButtonStyleTypes.DANGER,
                  }
                ],
              },
            ],
        },
      });

    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
  // custom_id set in payload when sending message component
  const componentId = data.custom_id;
  
  if (componentId.startsWith('yes_button_') || componentId.startsWith('no_button_')) {
    const isYes = componentId.startsWith('yes_button_');
    const voteId = componentId.replace(isYes ? 'yes_button_' : 'no_button_', '');
    const vote = activeVotes[voteId];

    // Vote is either expired or has errored out
    if (!vote) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [{
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: 'This vote is no longer active.',
          }],
        },
      });
    }

    // Idenfity the voter
    const context = req.body.context;
    const voterId = context === 0 ? req.body.member.user.id : req.body.user.id;

    const voterVS = await getVoiceState(vote.guildId, voterId);
    // Verify they're in the same VC as the target
    if (voterVS?.channel_id !== vote.channelId) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [{
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: 'You must be in the voice channel to vote.',
          }],
        },
      });
    }

    // Verify they aren't the target of the vote
    if (voterId === vote.targetUserId) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.EPHEMERAL | InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [{
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: "You can't vote on your own gag.",
          }],
        },
      });
    }

    // Record the vote
    vote.yesVoters.delete(voterId);
    vote.noVoters.delete(voterId);
    (isYes ? vote.yesVoters : vote.noVoters).add(voterId);

    return res.send({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [{
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `Vote to gag <@${vote.targetUserId}>: **${vote.yesVoters.size}** yes, **${vote.noVoters.size}** no. Voting closes in <t:${Math.floor((vote.startedAt + 60_000) / 1000)}:R>.`,
        },
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.BUTTON,
              custom_id: `yes_button_${voteId}`,
              label: 'Vote Yes',
              style: ButtonStyleTypes.DANGER,
            },
            {
              type: MessageComponentTypes.BUTTON,
              custom_id: `no_button_${voteId}`,
              label: 'Vote No',
              style: ButtonStyleTypes.SECONDARY,
            },
          ],
        },
        ],
      },
    });

  } 

  return;
}

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});

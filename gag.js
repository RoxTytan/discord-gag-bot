import { DiscordRequest } from './utils.js';
import { MessageComponentTypes, InteractionResponseFlags } from 'discord-interactions';

const MUTE_DURATION_MS = 60_000;

export async function resolveVote(voteId, interactionToken, appId, activeVotes) {
  const vote = activeVotes[voteId];
  if (!vote) return; // already cleaned up

  const yes = vote.yesVoters.size;
  const no = vote.noVoters.size;
  const passes = yes > no; // strict majority of voters, ties fail

  delete activeVotes[voteId];

  let content;
  if (yes + no === 0) {
    content = `No votes cast. <@${vote.targetUserId}> is safe.`;
  } else if (passes) {
    try {
      await muteUser(vote.guildId, vote.targetUserId, true);
      content = `Vote passed (${yes}–${no}). <@${vote.targetUserId}> has been gagged for 60 seconds.`;
      setTimeout(() => muteUser(vote.guildId, vote.targetUserId, false).catch(console.error), MUTE_DURATION_MS);
    } catch (err) {
      console.error('Mute failed:', err);
      content = `Vote passed (${yes}–${no}), but the mute failed. (Permissions?)`;
    }
  } else {
    content = `Vote failed (${yes}–${no}). <@${vote.targetUserId}> is safe.`;
  }

  // Edit the original vote message to show the final result and remove buttons
  const endpoint = `webhooks/${appId}/${interactionToken}/messages/@original`;
  await DiscordRequest(endpoint, {
    method: 'PATCH',
    body: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [{
        type: MessageComponentTypes.TEXT_DISPLAY,
        content,
      }],
    },
  }).catch(console.error);
}

async function muteUser(guildId, userId, mute) {
  return DiscordRequest(`guilds/${guildId}/members/${userId}`, {
    method: 'PATCH',
    body: { mute },
  });
}
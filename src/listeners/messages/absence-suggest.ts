import { App } from '@slack/bolt';
import * as chrono from 'chrono-node';
import { addMonths, format, startOfDay } from 'date-fns';
import {
  generateTimeText,
  isGenericMessageEvent,
  isWeekendInRange,
} from '../../helpers';
import getAccessTokenFromServiceAccount from '../../services/get-access-token-from-service-account';
import { serviceAccountKey } from '../../services/service-account-key';
import { DayPart } from '../../types';

export default function suggestAbsence(app: App) {
  app.message(
    /(^|\s)(off|nghỉ)([?!.,]|$|\s(?!sớm))/gi,
    async ({ message, say, client, logger }) => {
      // Filter out message events with subtypes (see https://api.slack.com/events/message)
      // Is there a way to do this in listener middleware with current type system?
      if (!isGenericMessageEvent(message)) return;
      if (message.channel !== process.env.SLACK_CHANNEL) return;
      if (!message.blocks) return;

      const accessToken = await getAccessTokenFromServiceAccount();

      const translationResponse = await fetch(
        `https://translation.googleapis.com/v3/projects/${serviceAccountKey.project_id}:translateText`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            sourceLanguageCode: 'vi',
            targetLanguageCode: 'en',
            contents: message.text
              ?.replaceAll(/t2|thứ 2/gi, 'monday')
              ?.replaceAll(/t3|thứ 3/gi, 'tuesday')
              ?.replaceAll(/t4|thứ 4/gi, 'wednesdays')
              ?.replaceAll(/t5|thứ 5/gi, 'thursday')
              ?.replaceAll(/t6|thứ 6/gi, 'friday')
              ?.replaceAll(/nghỉ/gi, 'off')
              ?.replaceAll(/\//g, ' tháng ')
              ?.replaceAll(/-/g, ' đến '),
            mimeType: 'text/plain',
          }),
        },
      );
      const translationObject = await translationResponse.json();
      const translatedText = translationObject.translations[0].translatedText;
      logger.info('translatedText', translatedText);

      const ranges = chrono.parse(translatedText);
      const map = new Map();
      ranges.map(async (range) => {
        const startDate = range.start.date();
        const endDate = range.end?.date() || startDate;

        // ignore duplicated range
        const hash =
          startDate.toDateString() +
          startDate.getHours() +
          endDate.toDateString() +
          endDate.getHours();
        if (map.has(hash)) return;
        map.set(hash, true);

        const today = startOfDay(new Date());

        const startDateString = format(startDate, 'yyyy-MM-dd');
        const endDateString = format(endDate, 'yyyy-MM-dd');
        const isSingleMode = startDateString === endDateString;

        logger.info('startDate', startDate);
        logger.info('endDate', endDate);
        logger.info('startDate.getHours()', startDate.getHours());
        logger.info('endDate.getHours()', endDate.getHours());

        if (!startDate) return;
        let dayPart = DayPart.ALL;
        if (
          startDate.getTime() ===
          new Date(new Date(startDate).setHours(6, 0, 0, 0)).getTime()
        ) {
          dayPart = DayPart.MORNING;
        }

        if (
          startDate.getTime() ===
          new Date(new Date(startDate).setHours(15, 0, 0, 0)).getTime()
        ) {
          dayPart = DayPart.AFTERNOON;
        }

        if (new Date(new Date(startDate).setHours(15, 0, 0, 0)) < new Date()) {
          return;
        }
        if (isWeekendInRange(startDate, endDate)) {
          const failureText = `:x: Failed to create. Not allow weekend in range`;
          await client.chat.postEphemeral({
            channel: process.env.SLACK_CHANNEL!,
            user: message.user,
            text: failureText,
          });
          return;
        }
        if (endDate < startDate) return;
        if (startDate > addMonths(today, 3)) return;
        if (endDate > addMonths(today, 3)) return;
        if (!isSingleMode && dayPart !== DayPart.ALL) return;

        const timeText = generateTimeText(startDate, endDate, dayPart);
        const quote = (message.text || '')
          .split('\n')
          .map((text: string) => `>${text}`)
          .join('\n');

        await say({
          thread_ts: message.ts,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${quote}\n<@${message.user}>, are you going to be absent *${timeText}*?`,
                verbatim: true,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  action_id: 'absence-suggestion-yes',
                  text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'Yes',
                  },
                  style: 'primary',
                  value: JSON.stringify({
                    startDateString,
                    endDateString,
                    dayPart,
                    reason: message.text,
                    authorId: message.user,
                  }),
                  confirm: {
                    title: {
                      type: 'plain_text',
                      text: 'Absence confirm',
                      emoji: true,
                    },
                    text: {
                      type: 'mrkdwn',
                      text: `Do you confirm to be absent ${timeText}?\n The submission will take some time, please be patient.`,
                      verbatim: true,
                    },
                    confirm: {
                      type: 'plain_text',
                      text: 'Confirm',
                      emoji: true,
                    },
                  },
                },
                {
                  type: 'button',
                  action_id: 'absence-new',
                  text: {
                    type: 'plain_text',
                    emoji: true,
                    text: 'No, submit myself',
                  },
                },
              ],
            },
          ],
          text: `Are you going to be absent ${timeText}?`,
        });
      });

      await say({
        thread_ts: message.ts,
        text: '<@UL85VPR89>',
      });
    },
  );
}

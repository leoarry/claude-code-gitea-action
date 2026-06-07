#!/usr/bin/env bun

/**
 * Create the initial tracking comment when Claude Code starts working
 * This comment shows the working status and includes a link to the job run
 */

import { appendFileSync } from "fs";
import { createJobRunLink, createCommentBody } from "./common";
import {
  isPullRequestReviewCommentEvent,
  type ParsedGitHubContext,
} from "../../context";
import type { GiteaApiClient } from "../../api/gitea-client";

export async function createInitialComment(
  api: GiteaApiClient,
  context: ParsedGitHubContext,
) {
  const { owner, repo } = context.repository;

  const jobRunLink = createJobRunLink(owner, repo, context.runId);
  const initialBody = createCommentBody(jobRunLink);

  console.log(
    `Creating comment for ${context.isPR ? "PR" : "issue"} #${context.entityNumber}`,
  );

  // For inline review comment events, reply in the same thread using the
  // Gitea reply endpoint: POST /pulls/{index}/comments/{id}/replies
  if (isPullRequestReviewCommentEvent(context)) {
    const comment = (context.payload as any).comment;
    if (comment?.id) {
      try {
        console.log(`Replying to PR review comment ${comment.id}`);
        const response = await api.customRequest(
          "POST",
          `/api/v1/repos/${owner}/${repo}/pulls/${context.entityNumber}/comments/${comment.id}/replies`,
          { body: initialBody },
        );
        const githubOutput = process.env.GITHUB_OUTPUT!;
        appendFileSync(githubOutput, `claude_comment_id=${response.data.id}\n`);
        console.log(`✅ Created review reply with ID: ${response.data.id}`);
        return response.data.id;
      } catch (error) {
        console.warn(`Failed to reply to review comment, falling back to issue comment: ${error}`);
      }
    }
  }

  // Default: create a regular issue/PR comment
  const response = await api.createIssueComment(
    owner,
    repo,
    context.entityNumber,
    initialBody,
  );
  const githubOutput = process.env.GITHUB_OUTPUT!;
  appendFileSync(githubOutput, `claude_comment_id=${response.data.id}\n`);
  console.log(`✅ Created initial comment with ID: ${response.data.id}`);
  return response.data.id;
}

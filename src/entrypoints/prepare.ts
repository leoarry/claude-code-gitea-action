#!/usr/bin/env bun

/**
 * Prepare the Claude action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkTriggerAction } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { checkWritePermissions } from "../github/validation/permissions";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { setupBranch } from "../github/operations/branch";
import { updateTrackingComment } from "../github/operations/comments/update-with-branch";
import { prepareMcpConfig } from "../mcp/install-mcp-server";
import { createPrompt } from "../create-prompt";
import { createClient } from "../github/api/client";
import { fetchGitHubData } from "../github/data/fetcher";
import {
  parseGitHubContext,
  isPullRequestReviewCommentEvent,
} from "../github/context";
import { getMode } from "../modes/registry";

async function run() {
  try {
    // Step 1: Setup GitHub token
    const githubToken = await setupGitHubToken();
    const client = createClient(githubToken);

    // Step 2: Parse GitHub context (once for all operations)
    const context = parseGitHubContext();

    // Step 3: Check write permissions
    const hasWritePermissions = await checkWritePermissions(
      client.api,
      context,
    );
    if (!hasWritePermissions) {
      throw new Error(
        "Actor does not have write permissions to the repository",
      );
    }

    // Step 4: Gitea sends empty review.content in the webhook payload for
    // pull_request_review_comment events. Fetch the actual inline comment
    // content from the API and inject it so the trigger check can find it.
    // Only handle pull_request_review_comment here — pull_request_review fires
    // for the same user action and would cause a double trigger.
    if (
      isPullRequestReviewCommentEvent(context) &&
      (context.payload.comment?.body ?? context.payload.review?.content) === ""
    ) {
      try {
        const { owner, repo } = context.repository;
        const reviewsResp = await client.api.listPullRequestReviews(
          owner,
          repo,
          context.entityNumber,
        );
        const reviewsList: any[] = Array.isArray(reviewsResp.data)
          ? reviewsResp.data
          : [];
        if (reviewsList.length > 0) {
          const latestReview = reviewsList.sort(
            (a: any, b: any) =>
              new Date(b.submitted_at ?? b.updated_at).getTime() -
              new Date(a.submitted_at ?? a.updated_at).getTime(),
          )[0];
          const commentsResp = await client.api.listPullRequestReviewComments(
            owner,
            repo,
            context.entityNumber,
            latestReview.id,
          );
          const commentsList: any[] = Array.isArray(commentsResp.data)
            ? commentsResp.data
            : [];
          const latestComment = commentsList.sort(
            (a: any, b: any) =>
              new Date(b.updated_at ?? b.created_at).getTime() -
              new Date(a.updated_at ?? a.created_at).getTime(),
          )[0];
          const content = latestComment?.body || latestReview?.body;
          if (content) {
            (context.payload as any).review = {
              ...(context.payload as any).review,
              content,
            };
            // Inject comment id and user so commentId is set correctly downstream
            if (latestComment) {
              (context.payload as any).comment = {
                id: latestComment.id,
                body: latestComment.body,
                user: latestComment.user,
              };
            }
            (context.payload as any).sender ??= {
              login: latestComment?.user?.login ?? latestReview?.user?.login,
            };
          }
        }
      } catch (error) {
        console.warn(
          `Could not fetch Gitea inline review comment body: ${error}`,
        );
      }
    }

    // Step 5: Check trigger conditions
    const containsTrigger = await checkTriggerAction(context);

    // Set outputs that are always needed
    core.setOutput("contains_trigger", containsTrigger.toString());
    core.setOutput("GITHUB_TOKEN", githubToken);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    // Step 6: Check if actor is human
    await checkHumanActor(client.api, context);

    const mode = getMode(context.inputs.mode);

    // Step 7: Create initial tracking comment (if required by mode)
    let commentId: number | undefined;
    if (mode.shouldCreateTrackingComment()) {
      commentId = await createInitialComment(client.api, context);
      core.setOutput("claude_comment_id", commentId!.toString());
    }

    // Step 8: Fetch GitHub data (once for both branch setup and prompt creation)
    const githubData = await fetchGitHubData({
      client: client,
      repository: `${context.repository.owner}/${context.repository.repo}`,
      prNumber: context.entityNumber.toString(),
      isPR: context.isPR,
    });

    // Step 9: Setup branch
    const branchInfo = await setupBranch(client, githubData, context);
    core.setOutput("BASE_BRANCH", branchInfo.baseBranch);
    if (branchInfo.claudeBranch) {
      core.setOutput("CLAUDE_BRANCH", branchInfo.claudeBranch);
    }

    // Step 10: Update initial comment with branch link (only if a claude branch was created)
    if (commentId && branchInfo.claudeBranch) {
      await updateTrackingComment(
        client,
        context,
        commentId,
        branchInfo.claudeBranch,
      );
    }

    // Step 11: Create prompt file
    const modeContext = mode.prepareContext(context, {
      commentId,
      baseBranch: branchInfo.baseBranch,
      claudeBranch: branchInfo.claudeBranch,
    });

    await createPrompt(mode, modeContext, githubData, context);

    // Step 12: Get MCP configuration
    const mcpConfig = await prepareMcpConfig({
      githubToken,
      owner: context.repository.owner,
      repo: context.repository.repo,
      branch: branchInfo.currentBranch,
      baseBranch: branchInfo.baseBranch,
      allowedTools: context.inputs.allowedTools,
      context,
    });
    core.setOutput("mcp_config", mcpConfig);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);
    // Also output the clean error message for the action to capture
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}

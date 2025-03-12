import { Probot } from "probot";
import fetch from "node-fetch";
import 'dotenv/config'; // Ensure .env file is loaded

// GibWork API interfaces
interface GibWorkRequestBody {
  title: string;
  content: string;
  requirements: string;
  tags: string[];
}

interface GibWorkResponse {
  taskId: string;
  link: string;
  addressToDepositFunds: string;
}

const DEFAULT_API_KEY = process.env.GIBWORK_API_KEY || "YGmwoZFLRA2p96oDbap033jpWMIPUnKm1Phlb1lz";
const apiKeyCache: Record<string, string> = {};

function getApiKey(repoOwner: string, repoName: string, isOrg: boolean): string {

  let apiKey = null;
  
  if (isOrg) {
    apiKey = apiKeyCache[repoOwner];
  }
  
  if (!apiKey) {
    const repoKey = `${repoOwner}/${repoName}`;
    apiKey = apiKeyCache[repoKey];
  }
  
  if (!apiKey) {
    apiKey = DEFAULT_API_KEY;
  }
  
  return apiKey;
}

export default (app: Probot) => {

  // Listen for issue comments to handle commands
  app.on("issue_comment.created", async (context) => {
    try {
      const repoOwner = context.payload.repository.owner.login;
      const repoName = context.payload.repository.name;
      const isOrg = context.payload.repository.owner.type === "Organization";
      
      app.log.info(`Received issue_comment.created event in ${repoOwner}/${repoName} (isOrg: ${isOrg})`);
      app.log.info(`Repository type: ${context.payload.repository.owner.type}`);
      app.log.info(`Full payload: ${JSON.stringify(context.payload, null, 2).substring(0, 500)}...`);
      
      const comment = context.payload.comment.body || "";
      const commentId = context.payload.comment.id;
      const username = context.payload.comment.user.login;
      
      app.log.info(`Comment from user ${username}: ${comment.substring(0, 20)}...`);

      // Check for setApiKey command
      const setApiKeyMatch = comment.match(/\/setApiKey\s+([^\s]+)/);
      if (setApiKeyMatch) {
        app.log.info(`SetApiKey command detected from ${username}`);
        await handleSetApiKey(context, username, repoOwner, repoName, isOrg, setApiKeyMatch[1], commentId);
        return;
      }
      
      // Check for bounty command
      if (/\/bounty\b/i.test(comment)) {
        app.log.info(`Bounty command detected from ${username}`);
        await handleBountyCommand(context, username, repoOwner, repoName, isOrg);
        return;
      }
      
      app.log.info("No recognized command in comment");
      
    } catch (error: any) {
      app.log.error(`Error handling comment: ${error.message}`);
      app.log.error(`Stack trace: ${error.stack}`);
      try {
        await context.octokit.issues.createComment(context.issue({
          body: `Error: ${error.message}`,
        }));
      } catch (commentError: any) {
        app.log.error(`Could not post error comment: ${commentError.message}`);
      }
    }
  });

  // Handle /setApiKey command
  async function handleSetApiKey(
    context: any, 
    username: string, 
    repoOwner: string, 
    repoName: string, 
    isOrg: boolean, 
    apiKey: string, 
    commentId: number
  ) {
    app.log.info(`SetApiKey command detected from ${username}, checking permissions`);
    
    // Check user permissions
    let hasPermission = false;
    let permissionCheckFailed = false; // Flag to track if permission check failed due to error
    
    try {
      if (isOrg) {
        // For organizations, check if user is ANY org member (not just admin)
        try {
          // Just check if the API call succeeds, no need to store the response
          await context.octokit.orgs.checkMembershipForUser({
            org: repoOwner,
            username: username
          });
          
          // If above doesn't throw an error, user is an org member
          hasPermission = true;
          app.log.info(`User ${username} is a member of organization ${repoOwner}`);
          
        } catch (orgError: any) {
          if (orgError.status === 404) {
            app.log.info(`User ${username} is not a member of organization ${repoOwner}`);
          } else {
            app.log.error(`Error checking org membership: ${orgError.message}`);
            permissionCheckFailed = true;
          }
        }
      } else {
        // For personal repositories, check if user is repository owner (admin permission)
        try {
          const collaboratorResponse = await context.octokit.repos.getCollaboratorPermissionLevel({
            owner: repoOwner,
            repo: repoName,
            username: username
          });
          
          if (collaboratorResponse.data.permission === 'admin') {
            hasPermission = true;
            app.log.info(`User ${username} is a repository admin`);
          } else {
            app.log.info(`User ${username} has permission level: ${collaboratorResponse.data.permission}, which is not admin`);
          }
        } catch (error: any) {
          app.log.error(`Error checking repo permissions: ${error.message}`);
          permissionCheckFailed = true;
        }
      }
    } catch (permError: any) {
      app.log.error(`Error in permission checking block: ${permError.message}`);
      app.log.error(`Stack trace: ${permError.stack}`);
      permissionCheckFailed = true;
    }

    // Only deny if we're sure user doesn't have permission (no errors occurred)
    if (!hasPermission && !permissionCheckFailed) {
      app.log.info(`User ${username} doesn't have permission to set API key`);
      
      const errorMessage = isOrg
        ? `Permission denied: Only organization members can set the organization-wide API key.`
        : `Permission denied: Only repository owners can set the API key.`;
      
      await context.octokit.issues.createComment(context.issue({
        body: errorMessage
      }));
      return;
    }

    // If permission check failed, log it but proceed as if permission granted
    if (permissionCheckFailed) {
      app.log.warn(`Permission check failed for ${username}, proceeding with API key set operation anyway`);
    }

    try {
      // Store the API key
      const cacheKey = isOrg ? repoOwner : `${repoOwner}/${repoName}`;
      apiKeyCache[cacheKey] = apiKey;
      
      app.log.info(`API key set for ${isOrg ? 'organization ' + repoOwner : 'repository ' + cacheKey}`);
      
      // Delete the comment with the API key for security
      try {
        await context.octokit.issues.deleteComment({
          owner: repoOwner,
          repo: repoName,
          comment_id: commentId
        });
        app.log.info(`Deleted comment with API key`);
      } catch (deleteError: any) {
        app.log.error(`Failed to delete comment with API key: ${deleteError.message}`);
        if (deleteError.status) {
          app.log.error(`Status code: ${deleteError.status}`);
        }
      }
      
      // Notify that the key was set successfully
      const successMessage = isOrg
        ? `Organization-wide API key set successfully. This key will be used for all repositories in the ${repoOwner} organization. The comment with your API key has been deleted for security.`
        : `Repository API key set successfully. The comment with your API key has been deleted for security.`;
      
      await context.octokit.issues.createComment(context.issue({
        body: successMessage
      }));
    } catch (error: any) {
      app.log.error(`Error setting API key: ${error.message}`);
      await context.octokit.issues.createComment(context.issue({
        body: `Error setting API key: ${error.message}`
      }));
      
      // Still try to delete the comment with the API key
      try {
        await context.octokit.issues.deleteComment({
          owner: repoOwner,
          repo: repoName,
          comment_id: commentId
        });
      } catch (deleteError: any) {
        app.log.error(`Failed to delete comment with API key: ${deleteError.message}`);
      }
    }
  }
  
  // Handle /bounty command
  async function handleBountyCommand(
    context: any, 
    username: string, 
    repoOwner: string, 
    repoName: string, 
    isOrg: boolean
  ) {
    app.log.info("Bounty command detected, checking permissions");

    // Check if user has proper permissions
    let hasPermission = false;
    
    try {
      // First check if user is a collaborator with write or admin access
      try {
        const collaboratorResponse = await context.octokit.repos.getCollaboratorPermissionLevel({
          owner: repoOwner,
          repo: repoName,
          username: username
        });
        
        const permission = collaboratorResponse.data.permission;
        if (permission === 'admin' || permission === 'write') {
          hasPermission = true;
          app.log.info(`User ${username} has repo permission: ${permission}`);
        } else {
          app.log.info(`User ${username} has repo permission: ${permission}, which is insufficient`);
        }
      } catch (error: any) {
        app.log.info(`Error checking repo collaborator status: ${error.message}`);
        if (error.status) {
          app.log.info(`Status code: ${error.status}`);
        }
      }
      
      // If not a collaborator with sufficient permissions and repo belongs to an org,
      // check if user is an org member
      if (!hasPermission && isOrg) {
        try {
          await context.octokit.orgs.checkMembershipForUser({
            org: repoOwner,
            username: username
          });
          // If above doesn't throw an error, user is an org member
          hasPermission = true;
          app.log.info(`User ${username} is a member of organization ${repoOwner}`);
        } catch (orgError: any) {
          app.log.info(`Error checking org membership: ${orgError.message}`);
          if (orgError.status) {
            app.log.info(`Status code: ${orgError.status}`);
          }
        }
      }
    } catch (permError: any) {
      app.log.error(`Error checking permissions: ${permError.message}`);
      app.log.error(`Stack trace: ${permError.stack}`);
    }

    // Only proceed if user has proper permissions
    if (!hasPermission) {
      app.log.info(`User ${username} doesn't have permission to create bounties`);
      await context.octokit.issues.createComment(context.issue({
        body: `Permission denied: Only repository collaborators with write access or organization members can create bounties.`
      }));
      return;
    }
    
    // Get the API key using the helper function
    const apiKey = getApiKey(repoOwner, repoName, isOrg);
    
    const keySource = apiKeyCache[repoOwner] 
      ? 'organization-wide API key' 
      : apiKeyCache[`${repoOwner}/${repoName}`]
        ? 'repository-specific API key'
        : 'default API key';
    
    app.log.info(`Using ${keySource}`);

    // Get issue details
    const issue = await context.octokit.issues.get(context.issue());
    const title = issue.data.title;
    const content = issue.data.body || "No description provided";

    // Get the repository's languages to determine the most used language
    const languagesResponse = await context.octokit.repos.listLanguages({
      owner: repoOwner,
      repo: repoName,
    });

    const languages = languagesResponse.data;
    let mostUsedLanguage = "other";
    let maxBytes = 0;
    for (const [language, bytes] of Object.entries(languages)) {
      // Ensure bytes is treated as a number
      const bytesValue = Number(bytes);
      if (!isNaN(bytesValue) && bytesValue > maxBytes) {
        mostUsedLanguage = language;
        maxBytes = bytesValue;
      }
    }

    // Prepare the request body for the GibWork API
    const requestBody: GibWorkRequestBody = {
      title: title,
      content: content,
      requirements: "PR TO BE MERGED",
      tags: [mostUsedLanguage],
    };

    app.log.info(`Making API call to GibWork with body: ${JSON.stringify(requestBody)}`);

    // Make the API call to GibWork
    const url = "https://api2.gib.work/tasks/public";
    const options = {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    };

    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorText = await response.text();
        app.log.error(`GibWork API error: ${response.status} - ${errorText}`);
        throw new Error(`GibWork API returned status ${response.status}: ${errorText}`);
      }

      const responseData = (await response.json()) as GibWorkResponse;
      app.log.info(`Successful API response: ${JSON.stringify(responseData)}`);

      // Post the API response as a comment on the issue
      await context.octokit.issues.createComment(context.issue({
        body: `✅ Bounty created on GibWork!

**Task ID**: ${responseData.taskId}
**Link**: ${responseData.link}
**Address to deposit funds**: \`${responseData.addressToDepositFunds}\`

You can view and manage this bounty at ${responseData.link}`,
      }));
    } catch (apiError: any) {
      app.log.error(`Error making GibWork API call: ${apiError.message}`);
      await context.octokit.issues.createComment(context.issue({
        body: `Error creating bounty: ${apiError.message}`,
      }));
    }
  }
};
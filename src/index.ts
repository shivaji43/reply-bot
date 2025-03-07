import { Probot } from "probot";
import fetch from "node-fetch";

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

// API key cache to avoid reading from secrets on every request
// Now organized to support org-wide API keys
const apiKeyCache: Record<string, string> = {};

export default (app: Probot) => {
  // Listen for app installations
  app.on("installation.created", async (context) => {
    try {
      app.log.info("New installation created");
      const orgName = context.payload.installation.account.login;
      const isOrg = context.payload.installation.account.type === "Organization";
      
      // Create a setup issue in the first repository with instructions
      if (context.payload.repositories && context.payload.repositories.length > 0) {
        const repo = context.payload.repositories[0];
        
        // Different instructions depending on whether it's an org or user
        const setupInstructions = isOrg 
          ? `Thanks for installing the GibWork integration bot!

To set your organization-wide GibWork API key, any organization member can post a comment with:

\`/setApiKey YOUR_API_KEY\`

The comment will be automatically deleted for security.

**Note**: This API key will be shared across all repositories in your organization.

Once set up, you can create bounties by commenting \`/bounty\` on any issue.

**Note**: Only repository collaborators with write access or organization members can create bounties.`
          : `Thanks for installing the GibWork integration bot!

To set your GibWork API key, a repository owner can post a comment with:

\`/setApiKey YOUR_API_KEY\`

The comment will be automatically deleted for security.

Once set up, you can create bounties by commenting \`/bounty\` on any issue.

**Note**: Only repository collaborators with write access can create bounties.`;
        
        await context.octokit.issues.create({
          owner: orgName,
          repo: repo.name,
          title: "GibWork Integration Setup",
          body: setupInstructions,
        });
      } else {
        app.log.warn(`Installation for org ${orgName} has no repositories.`);
      }
    } catch (error: any) {
      app.log.error(`Error during installation: ${error.message}`);
    }
  });

  // Optionally: Comment on new issues
  app.on("issues.opened", async (context) => {
    try {
      // Only comment if the issue body does NOT include a bounty command
      if (!context.payload.issue.body?.includes('/bounty')) {
        await context.octokit.issues.createComment(context.issue({
          body: "Thanks for opening this issue!",
        }));
      }
    } catch (error: any) {
      app.log.error(`Error commenting on new issue: ${error.message}`);
    }
  });

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
          body: `❌ Error: ${error.message}`,
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
    
    try {
      if (isOrg) {
        // For organizations, check if user is ANY org member (not just admin)
        try {
          await context.octokit.orgs.checkMembershipForUser({
            org: repoOwner,
            username: username
          });
          
          // If above doesn't throw an error, user is an org member
          hasPermission = true;
          app.log.info(`User ${username} is a member of organization ${repoOwner}`);
          
        } catch (orgError: any) {
          app.log.info(`User ${username} is not a member of organization ${repoOwner}: ${orgError.message}`);
          if (orgError.status) {
            app.log.info(`Status code: ${orgError.status}`);
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
          app.log.info(`Error checking repo permissions: ${error.message}`);
          if (error.status) {
            app.log.info(`Status code: ${error.status}`);
          }
        }
      }
    } catch (permError: any) {
      app.log.error(`Error checking permissions: ${permError.message}`);
      app.log.error(`Stack trace: ${permError.stack}`);
    }

    // Only proceed if user has proper permissions
    if (!hasPermission) {
      app.log.info(`User ${username} doesn't have permission to set API key`);
      
      const errorMessage = isOrg
        ? `❌ Permission denied: Only organization members can set the organization-wide API key.`
        : `❌ Permission denied: Only repository owners can set the API key.`;
      
      await context.octokit.issues.createComment(context.issue({
        body: errorMessage
      }));
      return;
    }

    try {
      // Store the API key
      // For organizations, store it with just the org name as the key to make it org-wide
      // For personal repos, store it with the full repo path
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
        ? `✅ Organization-wide API key set successfully. This key will be used for all repositories in the ${repoOwner} organization. The comment with your API key has been deleted for security.`
        : `✅ Repository API key set successfully. The comment with your API key has been deleted for security.`;
      
      await context.octokit.issues.createComment(context.issue({
        body: successMessage
      }));
    } catch (error: any) {
      app.log.error(`Error setting API key: ${error.message}`);
      await context.octokit.issues.createComment(context.issue({
        body: `❌ Error setting API key: ${error.message}`
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
        body: `❌ Permission denied: Only repository collaborators with write access or organization members can create bounties.`
      }));
      return;
    }

    // Notify the user that the bounty request is being processed
    await context.octokit.issues.createComment(context.issue({
      body: "⏳ Processing bounty request...",
    }));

    // Get the API key - check for organization-wide key first, then repository specific key
    let apiKey = null;
    
    if (isOrg) {
      // First try to get the org-wide key
      apiKey = apiKeyCache[repoOwner];
      app.log.info(`Looking for org-wide API key for ${repoOwner}: ${apiKey ? 'Found' : 'Not found'}`);
    }
    
    // If no org-wide key found (or not an org), try repository-specific key
    if (!apiKey) {
      const repoKey = `${repoOwner}/${repoName}`;
      apiKey = apiKeyCache[repoKey];
      app.log.info(`Looking for repo-specific API key for ${repoKey}: ${apiKey ? 'Found' : 'Not found'}`);
    }
    
    if (!apiKey) {
      const errorMessage = isOrg
        ? `❌ API key not set. Please ask an organization member to set the organization-wide API key using \`/setApiKey YOUR_API_KEY\``
        : `❌ API key not set. Please set the API key using \`/setApiKey YOUR_API_KEY\``;
      
      await context.octokit.issues.createComment(context.issue({
        body: errorMessage
      }));
      return;
    }

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
        body: `❌ Error creating bounty: ${apiError.message}`,
      }));
    }
  }
};
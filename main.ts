import notifier from "node-notifier";

// Configure in .env
const BUILDKITE_TOKEN = process.env.BUILDKITE_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const USERNAME = process.env.USERNAME;
const BUILDKITE_PIPELINE_NAME = process.env.BUILDKITE_PIPELINE_NAME;

console.log("running Buildkite watcher");

const lastStatusByBranch = new Map<string, string>();

async function main() {
  while (true) {
    const prsToWatch = await getPRsToWatch();

    await checkPRs(prsToWatch);

    // Buildkite will tell when a build begins to fail, unlike GitHub checks which only tell when a build is complete.
    await checkBuildkiteBuilds(prsToWatch.map((pr) => pr.headRef));

    // TODO: implement variable polling interval
    // where succeeded branches get polled less frequently
    // to reduce rate-limit usage
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

// TODO: notify on context node failures
// TODO: notify on Bugbot run completion
// TODO: notify on comment added
async function checkPRs(prsToWatch: { headRef: string; number: number }[]) {
  const githubSearchPrChecksQuery = `
  query GetMyRepositoryPRChecks($owner: String!, $name: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $prNumber) {
        title
        url
        # 1. Get the latest commit (head commit) of the PR
        commits(last: 1) {
          nodes {
            commit {
              oid
              # 2. Get the rollup of all check suites and commit statuses
              statusCheckRollup {
                state # Overall status rollup (e.g., SUCCESS, FAILURE, PENDING)
                contexts(last: 20) {
                  nodes {
                    ... on CheckRun {
                      __typename
                      name
                      status      # QUEUED, IN_PROGRESS, COMPLETED
                      conclusion  # SUCCESS, FAILURE, NEUTRAL, CANCELLED, SKIPPED, etc.
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

  for (const pr of prsToWatch) {
    const response = await fetch(`https://api.github.com/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "Node-Fetch-GraphQL-Script", // GitHub requires a User-Agent header
      },
      body: JSON.stringify({
        query: githubSearchPrChecksQuery,
        variables: {
          owner: REPO_OWNER,
          name: REPO_NAME,
          prNumber: pr.number,
        },
      }),
    });
    const checksData = await response.json();

    const responseHeaders = response.headers;
    const rateLimitHeaders = [...responseHeaders.entries()].filter(([key]) =>
      key.toLowerCase().startsWith("x-ratelimit"),
    );
    console.log(rateLimitHeaders);

    const latestStatus =
      checksData.data.repository.pullRequest.commits.nodes[0].commit
        .statusCheckRollup.state;
    const lastStatus = lastStatusByBranch.get(pr.headRef);
    if (latestStatus.toLowerCase() !== lastStatus) {
      console.log(`latest status for branch ${pr.headRef} is ${latestStatus}`);
      console.log(JSON.stringify(checksData, null, 2));

      let sound = "Frog";
      let icon = "🐸";
      if (latestStatus === "FAILURE") {
        sound = "Sosumi";
        icon = "💀";
      }

      notifier.notify({
        title: `${icon} ${pr.headRef} is ${latestStatus}`,
        message: `PR ${pr.number} for branch ${pr.headRef} is ${latestStatus}`,
        sound, // Defaults to false, or pass a sound name like 'Frog'
        wait: true, // wait for user action/click
        open: checksData.data.repository.pullRequest.url,
      });
      lastStatusByBranch.set(pr.headRef, latestStatus.toLowerCase());
    }
  }
}

async function checkBuildkiteBuilds(headRefsToWatch: string[]) {
  for (const branch of headRefsToWatch) {
    const builds = await fetch(
      `https://api.buildkite.com/v2/builds?exclude_jobs=true&exclude_pipeline=true&branch=${branch}`,
      {
        headers: {
          Authorization: `Bearer ${BUILDKITE_TOKEN}`,
        },
      },
    );
    const buildsData = await builds.json();
    //console.log(buildsData);
    const sortedBuilds = buildsData
      .filter((build: any) => build.pipeline.name === BUILDKITE_PIPELINE_NAME)
      .toSorted(
        (a: any, b: any) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    const latestBuild = sortedBuilds[0];

    const lastStatus = lastStatusByBranch.get(branch);
    if (
      latestBuild.state.toLowerCase() !== lastStatus &&
      (latestBuild.state === "failing" || latestBuild.state === "failed")
    ) {
      console.log(`latest status for branch ${branch} is ${latestBuild.state}`);

      let sound = "Frog";
      let icon = "🐸";
      if (latestBuild.state === "failed" || latestBuild.state === "failing") {
        sound = "Sosumi";
        icon = "💀";
      }

      console.log(latestBuild.web_url);

      notifier.notify({
        title: `${icon} ${branch} is ${latestBuild.state}`,
        message: `Build ${latestBuild.number} for branch ${branch} is ${latestBuild.state}`,
        sound, // Defaults to false, or pass a sound name like 'Frog'
        wait: true, // wait for user action/click
        open: latestBuild.web_url,
      });
      lastStatusByBranch.set(branch, latestBuild.state.toLowerCase());
    }
  }
}

// Construct the query string exactly like the GitHub search bar
const searchQuery = `repo:${REPO_OWNER}/${REPO_NAME} author:${USERNAME} is:pr is:open`;

const githubSearchPrQuery = {
  query: `
    query GetMyRepositoryPRs($searchString: String!) {
      search(query: $searchString, type: ISSUE, first: 20) {
        issueCount
        nodes {
          ... on PullRequest {
            number
            title
            state
            createdAt
            url
            headRef {
              name
            }
          }
        }
      }
    }
  `,
  variables: {
    searchString: searchQuery,
  },
};

async function getPRsToWatch(): Promise<{ headRef: string; number: number }[]> {
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "Node-Fetch-GraphQL-Script", // GitHub requires a User-Agent header
      },
      body: JSON.stringify(githubSearchPrQuery),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const result = await response.json();

    const responseHeaders = response.headers;
    const rateLimitHeaders = [...responseHeaders.entries()].filter(([key]) =>
      key.toLowerCase().startsWith("x-ratelimit"),
    );

    console.log(rateLimitHeaders);

    // Check for GraphQL-specific errors
    if (result.errors) {
      console.error("GraphQL Errors:", result.errors);
      return [];
    }

    // Access and display the PR data
    const prs = result.data.search.nodes;
    // console.log(`Found ${result.data.search.issueCount} PRs:\n`);

    // prs.forEach((pr: any) => {
    //   console.log(`[#${pr.number}] ${pr.title}`);
    //   console.log(`   State: ${pr.state} | URL: ${pr.url}\n`);
    //   console.log(`   Head Ref: ${pr.headRef.name}\n`);
    // });

    return prs.map((pr: any) => ({
      headRef: pr.headRef.name,
      number: pr.number,
    }));
  } catch (error) {
    console.error("Fetch operation failed:", error);

    return [];
  }
}

// Execute the main function using top-level await
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);

    notifier.notify({
      title: "Buildkite watcher crashed",
      message: "Error",
      sound: "Sosumi",
      wait: true,
    });
  }
}

// notifier.notify({
//   title: "Buildkite watcher",
//   message: "running",
//   sound: "Frog", // Defaults to false, or pass a sound name like 'Frog'
//   wait: true, // Wait for user action/click
// });

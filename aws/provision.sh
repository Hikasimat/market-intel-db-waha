#!/bin/bash
set -e

# ==============================================================================
# AWS CLI Automated Infrastructure Provisioning
# Creates VPC, Subnet, Security Group, ECR, and GitHub Actions OIDC Role
# ==============================================================================

AWS_REGION="${1:-ap-south-1}"
GITHUB_ORG="${2:-your-github-username}"
GITHUB_REPO="${3:-WAHA}"
STACK_NAME="waha-infrastructure"

echo "=========================================================="
echo "🚀 Provisioning WAHA Infrastructure via CloudFormation"
echo "Region:      $AWS_REGION"
echo "GitHub Repo: $GITHUB_ORG/$GITHUB_REPO"
echo "=========================================================="

aws cloudformation deploy \
  --template-file aws/cloudformation-vpc-ecr.yaml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      GitHubOrg="$GITHUB_ORG" \
      GitHubRepo="$GITHUB_REPO"

echo "✅ CloudFormation Stack Deployed!"
echo ""
echo "=== Stack Outputs ==="
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs" \
  --output table

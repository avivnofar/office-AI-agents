#!/bin/bash

# Data Center IT Runbook Builder - Installation Verification Script
# This script verifies that all components are properly installed and configured

echo "================================================================================"
echo "Data Center IT Runbook Builder - Installation Verification"
echo "================================================================================"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counter for checks
PASSED=0
FAILED=0

# Function to print check result
check_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ PASS${NC}: $2"
        ((PASSED++))
    else
        echo -e "${RED}✗ FAIL${NC}: $2"
        ((FAILED++))
    fi
}

# Function to print warning
print_warning() {
    echo -e "${YELLOW}⚠ WARNING${NC}: $1"
}

echo "1. CHECKING SYSTEM REQUIREMENTS"
echo "================================================================================"

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    NODE_MAJOR=$(echo $NODE_VERSION | cut -d'v' -f2 | cut -d'.' -f1)
    if [ $NODE_MAJOR -ge 18 ]; then
        check_result 0 "Node.js installed: $NODE_VERSION"
    else
        check_result 1 "Node.js version too old: $NODE_VERSION (requires 18+)"
    fi
else
    check_result 1 "Node.js not installed"
fi

# Check npm
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    check_result 0 "npm installed: $NPM_VERSION"
else
    check_result 1 "npm not installed"
fi

# Check pnpm (optional)
if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm --version)
    echo -e "${GREEN}✓ INFO${NC}: pnpm installed: $PNPM_VERSION (optional, npm will be used if not available)"
else
    print_warning "pnpm not installed (optional, npm will be used instead)"
fi

echo ""
echo "2. CHECKING PROJECT FILES"
echo "================================================================================"

# Check package.json
if [ -f "package.json" ]; then
    check_result 0 "package.json exists"
else
    check_result 1 "package.json not found"
fi

# Check dist directory
if [ -d "dist" ]; then
    check_result 0 "dist directory exists"
else
    check_result 1 "dist directory not found"
fi

# Check dist/public
if [ -d "dist/public" ]; then
    check_result 0 "dist/public directory exists"
else
    check_result 1 "dist/public directory not found"
fi

# Check index.html
if [ -f "dist/public/index.html" ]; then
    check_result 0 "dist/public/index.html exists"
else
    check_result 1 "dist/public/index.html not found"
fi

# Check dist/index.js
if [ -f "dist/index.js" ]; then
    check_result 0 "dist/index.js (server) exists"
else
    check_result 1 "dist/index.js (server) not found"
fi

echo ""
echo "3. CHECKING DEPENDENCIES"
echo "================================================================================"

# Check node_modules
if [ -d "node_modules" ]; then
    check_result 0 "node_modules directory exists"
    
    # Count packages
    PACKAGE_COUNT=$(ls -1 node_modules | wc -l)
    echo -e "${GREEN}✓ INFO${NC}: $PACKAGE_COUNT packages installed"
else
    print_warning "node_modules not found - run 'npm install' to install dependencies"
fi

echo ""
echo "4. CHECKING DOCUMENTATION"
echo "================================================================================"

# Check documentation files
DOCS=("README_EXPORT.md" "QUICKSTART.md" "DEPLOYMENT_GUIDE.md" "OPTIMIZATIONS.md" "MANIFEST.txt")
for doc in "${DOCS[@]}"; do
    if [ -f "$doc" ]; then
        check_result 0 "$doc exists"
    else
        check_result 1 "$doc not found"
    fi
done

echo ""
echo "5. CHECKING PORT AVAILABILITY"
echo "================================================================================"

# Check if port 3000 is available
if command -v lsof &> /dev/null; then
    if ! lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
        check_result 0 "Port 3000 is available"
    else
        print_warning "Port 3000 is already in use - you can use PORT=8080 npm start"
    fi
else
    echo -e "${YELLOW}⚠ INFO${NC}: lsof not available, skipping port check"
fi

echo ""
echo "================================================================================"
echo "VERIFICATION SUMMARY"
echo "================================================================================"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed! Your installation is ready.${NC}"
    echo ""
    echo "Next steps:"
    echo "1. If node_modules is not installed, run: npm install"
    echo "2. Start the server: npm start"
    echo "3. Open browser: http://localhost:3000"
    echo ""
    exit 0
else
    echo -e "${RED}✗ Some checks failed. Please fix the issues above.${NC}"
    echo ""
    echo "Common fixes:"
    echo "1. Install Node.js 18+: https://nodejs.org/"
    echo "2. Install dependencies: npm install"
    echo "3. Check documentation: see README_EXPORT.md"
    echo ""
    exit 1
fi

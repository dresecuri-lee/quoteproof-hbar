// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockSupraSValueFeed {
    struct PriceFeed {
        uint256 round;
        uint256 decimals;
        uint256 time;
        uint256 price;
    }

    PriceFeed private value;
    bool public shouldRevert;

    function setValue(uint256 round, uint256 decimals, uint256 time, uint256 price) external {
        value = PriceFeed(round, decimals, time, price);
    }

    function setShouldRevert(bool nextValue) external {
        shouldRevert = nextValue;
    }

    function getSvalue(uint256 pairIndex) external view returns (PriceFeed memory) {
        require(pairIndex == 432, "wrong pair");
        require(!shouldRevert, "oracle unavailable");
        return value;
    }
}

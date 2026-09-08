// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Original synthetic test fixture. Not a Robinhood contract or stock-token adapter.
/// A second display-unit event deliberately exercises the collector's topic filter.
contract StockSmoke {
    string public constant name = "PRESSURE Synthetic Stock";
    string public constant symbol = "PSS";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint256 public uiMultiplier = 1e18;
    address public immutable operator;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event UITransfer(address indexed from, address indexed to, uint256 displayValue);
    event UiMultiplierUpdated(uint256 previousMultiplier, uint256 nextMultiplier);

    constructor() { operator = msg.sender; }

    function mint(address to, uint256 amount) external {
        require(msg.sender == operator && to != address(0), "MINT");
        totalSupply += amount;
        balanceOf[to] += amount;
        _events(address(0), to, amount);
    }

    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        _events(msg.sender, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0) && balanceOf[msg.sender] >= amount, "TRANSFER");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        _events(msg.sender, to, amount);
        return true;
    }

    function setUiMultiplier(uint256 multiplier) external {
        require(msg.sender == operator && multiplier != 0, "MULTIPLIER");
        emit UiMultiplierUpdated(uiMultiplier, multiplier);
        uiMultiplier = multiplier;
    }

    function _events(address from, address to, uint256 amount) private {
        emit Transfer(from, to, amount);
        emit UITransfer(from, to, amount * uiMultiplier / 1e18);
    }
}

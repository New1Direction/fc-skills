// SPDX-License-Identifier: MIT
pragma solidity >=0.8.20 <0.9.0;

/// Original synthetic test contracts. These are not deployed Robinhood protocols.
contract SmokeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public immutable creator = msg.sender;
    uint256 public totalSupply;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        require(msg.sender == creator, "SETUP_ONLY");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "ALLOWANCE");
        allowance[from][msg.sender] -= amount;
        move(from, to, amount);
        return true;
    }

    function move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// Synthetic fixed-rate exchange, deducting 3% from its nominal output.
/// Exercises real allowance checks, transferFrom and output-wallet accounting.
contract SmokeRouter {
    SmokeToken public immutable input;
    SmokeToken public immutable output;
    constructor(address input_, address output_) {
        input = SmokeToken(input_);
        output = SmokeToken(output_);
    }

    function swap(uint256 amount, uint256 minimumOutput) external returns (uint256 received) {
        received = amount * 9700 / 10000;
        require(received >= minimumOutput, "MINIMUM_OUTPUT");
        require(input.transferFrom(msg.sender, address(this), amount), "INPUT_TRANSFER");
        require(output.transfer(msg.sender, received), "OUTPUT_TRANSFER");
    }
}

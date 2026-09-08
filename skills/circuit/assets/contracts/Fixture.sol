// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Original isolated test fixtures. The manager/router/Permit2 are separately
// deployed from pinned upstream creation artifacts; these are not replacements.
struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct ModifyLiquidityParams { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }
struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface IManagerFixture {
    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params, bytes calldata hookData)
        external returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}
interface ITokenFixture { function transfer(address to, uint256 amount) external returns (bool); }

contract FixtureToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 18;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount); return true;
    }
    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from, to, amount);
    }
}

contract FixtureLiquidity {
    IManagerFixture public immutable manager;
    constructor(address target) { manager = IManagerFixture(target); }
    receive() external payable {}
    function seed(PoolKey calldata key, uint160 sqrtPriceX96, int24 lower, int24 upper, int256 liquidity) external payable {
        manager.initialize(key, sqrtPriceX96);
        manager.unlock(abi.encode(key, ModifyLiquidityParams(lower, upper, liquidity, bytes32(0))));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager only");
        (PoolKey memory key, ModifyLiquidityParams memory params) = abi.decode(data, (PoolKey, ModifyLiquidityParams));
        (int256 delta,) = manager.modifyLiquidity(key, params, "");
        _settle(key.currency0, int128(delta >> 128));
        _settle(key.currency1, int128(delta));
        return "";
    }
    function _settle(address currency, int128 delta) private {
        if (delta < 0) {
            uint256 amount = uint256(-int256(delta));
            if (currency == address(0)) manager.settle{value: amount}();
            else { manager.sync(currency); require(ITokenFixture(currency).transfer(address(manager), amount)); manager.settle(); }
        } else if (delta > 0) manager.take(currency, address(this), uint256(int256(delta)));
    }
}

// Synthetic 1% afterSwap output deduction. This exercises V4 return-delta
// mechanics; it is explicitly not Pons source or a Pons deployment attestation.
contract FixtureFeeHook {
    IManagerFixture public immutable manager;
    constructor(address target) { manager = IManagerFixture(target); }
    receive() external payable {}
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, int256 delta, bytes calldata)
        external returns (bytes4, int128)
    {
        require(msg.sender == address(manager), "manager only");
        bool specifiedIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        int128 unspecified = specifiedIs0 ? int128(delta) : int128(delta >> 128);
        require(unspecified >= 0, "exact input only");
        uint256 fee = uint256(uint128(unspecified)) / 100;
        if (fee != 0) manager.take(specifiedIs0 ? key.currency1 : key.currency0, address(this), fee);
        return (this.afterSwap.selector, int128(uint128(fee)));
    }
}
contract FixtureFactory {
    function deployFeeHook(address manager, bytes32 salt) external returns (address) {
        return address(new FixtureFeeHook{salt: salt}(manager));
    }
}

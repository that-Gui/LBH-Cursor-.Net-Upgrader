using Xunit;

public class AlwaysFails
{
    [Fact]
    public void KnownBaselineFailure()
    {
        Assert.False(true);
    }
}
